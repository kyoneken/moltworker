import { decodeCbor, encodeCbor, type CborValue } from './cbor';
import { allowedEnvironments, requireAppId } from './config';
import {
  bytesEqual,
  bytesToBase64url,
  concatBytes,
  decodeFlexibleBase64,
  normalizeKeyId,
  sha256,
} from './encoding';
import { environmentFromAaguid, parseAuthenticatorData, type AuthenticatorData } from './authdata';
import { appleAppAttestRootDer } from './apple-root';
import {
  extractAppleNonce,
  importP256VerifyKey,
  rawEcPointFromSpki,
  verifyCertificateChain,
  verifyEcdsaSha256,
} from './x509';
import type {
  AppAttestEnvironment,
  AssertionVerifyResult,
  AttestationVerifyResult,
  AttestEnv,
} from './types';

export class AttestVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestVerificationError';
  }
}

/** Stable message when /v1/attest receives an assertion-shaped CBOR payload. */
export const ASSERTION_PAYLOAD_ERROR = 'payload looks like an assertion, not an attestation';

/** CTAP2 attestation-object integer keys: 1=fmt, 2=authData, 3=attStmt. */
const CTAP_FMT = 1;
const CTAP_AUTH_DATA = 2;
const CTAP_ATT_STMT = 3;

export interface VerifyAttestationOptions {
  attestation: string;
  keyId: string;
  challenge: Uint8Array;
  appId: string;
  allowedEnvs: Set<AppAttestEnvironment>;
  trustAnchorDer?: Uint8Array;
  now?: Date;
}

export interface VerifyAssertionOptions {
  assertion: string;
  keyId: string;
  clientData: Uint8Array;
  appId: string;
  publicKeySpki: Uint8Array;
  storedCounter: number;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new AttestVerificationError('expected CBOR map');
  }
  return value as Record<string, unknown>;
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new AttestVerificationError(`${label} must be a byte string`);
}

function cborField(decoded: Record<string, unknown>, stringKey: string, intKey: number): unknown {
  if (Object.prototype.hasOwnProperty.call(decoded, stringKey)) {
    return decoded[stringKey];
  }
  return decoded[String(intKey)];
}

function attestationFmt(decoded: Record<string, unknown>): unknown {
  return cborField(decoded, 'fmt', CTAP_FMT);
}

export function looksLikeAssertionObject(decoded: Record<string, unknown>): boolean {
  if (attestationFmt(decoded) === 'apple-appattest') {
    return false;
  }
  const stringAssertion =
    decoded.signature instanceof Uint8Array && decoded.authenticatorData instanceof Uint8Array;
  const integerAssertion =
    decoded[String(CTAP_AUTH_DATA)] instanceof Uint8Array &&
    decoded[String(CTAP_ATT_STMT)] instanceof Uint8Array &&
    !decoded.attStmt &&
    !decoded.authData;
  return stringAssertion || integerAssertion;
}

function parseAuthDataOrThrow(raw: Uint8Array, requireAttestedCredential: boolean) {
  try {
    return parseAuthenticatorData(raw, requireAttestedCredential);
  } catch (error) {
    throw new AttestVerificationError(
      error instanceof Error ? error.message : 'invalid authenticatorData',
    );
  }
}

function cborFieldSize(value: unknown): string {
  if (value === undefined) {
    return 'missing';
  }
  if (value instanceof Uint8Array) {
    return String(value.length);
  }
  if (typeof value === 'string') {
    return String(value.length);
  }
  try {
    return String(encodeCbor(value as CborValue).length);
  } catch {
    return 'unencodable';
  }
}

function describeAttestationMap(
  decoded: Record<string, unknown>,
  decodedBytes: Uint8Array,
): string {
  const keys = Object.keys(decoded).join(',');
  const fmt = cborField(decoded, 'fmt', CTAP_FMT);
  const attStmt = cborField(decoded, 'attStmt', CTAP_ATT_STMT);
  const authDataField = cborField(decoded, 'authData', CTAP_AUTH_DATA);
  return [
    `attestationDecodedBytes=${decodedBytes.length}`,
    `keys=[${keys}]`,
    `fmt.size=${cborFieldSize(fmt)}`,
    `attStmt.size=${cborFieldSize(attStmt)}`,
    `authData.size=${cborFieldSize(authDataField)}`,
  ].join(', ');
}

function decodeCborMap(
  payload: string,
  decodedBytesLabel: string,
): { decoded: Record<string, unknown>; decodedBytes: Uint8Array } {
  const decodedBytes = decodeFlexibleBase64(payload);
  try {
    return { decoded: asObject(decodeCbor(decodedBytes)), decodedBytes };
  } catch (error) {
    if (error instanceof AttestVerificationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'invalid CBOR';
    throw new AttestVerificationError(`${message} (${decodedBytesLabel}=${decodedBytes.length})`);
  }
}

export async function verifyAttestationObject(
  options: VerifyAttestationOptions,
): Promise<AttestationVerifyResult> {
  const { decoded, decodedBytes } = decodeCborMap(options.attestation, 'attestationDecodedBytes');
  if (looksLikeAssertionObject(decoded)) {
    throw new AttestVerificationError(ASSERTION_PAYLOAD_ERROR);
  }
  const fmt = attestationFmt(decoded);
  if (fmt !== 'apple-appattest') {
    throw new AttestVerificationError(`unexpected attestation fmt: ${String(fmt)}`);
  }
  const attStmt = asObject(cborField(decoded, 'attStmt', CTAP_ATT_STMT));
  const x5cRaw = attStmt.x5c;
  if (!Array.isArray(x5cRaw) || x5cRaw.length === 0) {
    throw new AttestVerificationError('attestation missing x5c');
  }
  const x5c = x5cRaw.map((cert, index) => {
    if (!(cert instanceof Uint8Array)) {
      throw new AttestVerificationError(`x5c[${index}] is not a byte string`);
    }
    return cert;
  });
  const authData = asBytes(cborField(decoded, 'authData', CTAP_AUTH_DATA), 'authData');
  let parsed: AuthenticatorData;
  try {
    parsed = parseAuthenticatorData(authData, true);
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : 'invalid authenticatorData';
    throw new AttestVerificationError(
      `${parseMessage}; ${describeAttestationMap(decoded, decodedBytes)}`,
    );
  }
  if (!parsed.aaguid || !parsed.credentialId) {
    throw new AttestVerificationError('attestation missing credential data');
  }
  if (parsed.signCounter !== 0) {
    throw new AttestVerificationError('attestation sign counter must be 0');
  }

  const leaf = await verifyCertificateChain(
    x5c,
    options.trustAnchorDer ?? appleAppAttestRootDer(),
    options.now,
  );

  const clientDataHash = await sha256(options.challenge);
  const expectedNonce = await sha256(concatBytes(authData, clientDataHash));
  const certNonce = extractAppleNonce(leaf);
  if (!bytesEqual(expectedNonce, certNonce)) {
    throw new AttestVerificationError('attestation nonce does not match challenge');
  }

  const rawPoint = await rawEcPointFromSpki(leaf.spki);
  const pointHash = await sha256(rawPoint);
  if (!bytesEqual(pointHash, parsed.credentialId)) {
    throw new AttestVerificationError('credentialId does not match attested public key');
  }

  const normalizedKeyId = normalizeKeyId(options.keyId);
  if (bytesToBase64url(parsed.credentialId) !== normalizedKeyId) {
    throw new AttestVerificationError('keyId does not match credentialId');
  }

  const expectedRpIdHash = await sha256(new TextEncoder().encode(options.appId));
  if (!bytesEqual(expectedRpIdHash, parsed.rpIdHash)) {
    throw new AttestVerificationError('authData rpIdHash does not match configured App ID');
  }

  const envName = environmentFromAaguid(parsed.aaguid);
  if (!options.allowedEnvs.has(envName)) {
    throw new AttestVerificationError(`App Attest environment ${envName} is not allowed`);
  }

  return {
    publicKeySpki: leaf.spki,
    env: envName,
    signCounter: 0,
    keyId: normalizedKeyId,
  };
}

export async function verifyAssertionObject(
  options: VerifyAssertionOptions,
): Promise<AssertionVerifyResult> {
  const { decoded } = decodeCborMap(options.assertion, 'assertionDecodedBytes');
  const signature = asBytes(cborField(decoded, 'signature', CTAP_ATT_STMT), 'signature');
  const authenticatorData = asBytes(
    cborField(decoded, 'authenticatorData', CTAP_AUTH_DATA),
    'authenticatorData',
  );
  const parsed = parseAuthDataOrThrow(authenticatorData, false);

  const expectedRpIdHash = await sha256(new TextEncoder().encode(options.appId));
  if (!bytesEqual(expectedRpIdHash, parsed.rpIdHash)) {
    throw new AttestVerificationError('assertion rpIdHash does not match configured App ID');
  }

  const clientDataHash = await sha256(options.clientData);
  const signedMessage = concatBytes(authenticatorData, clientDataHash);
  const publicKey = await importP256VerifyKey(options.publicKeySpki);
  const valid = await verifyEcdsaSha256(publicKey, signature, signedMessage);
  if (!valid) {
    throw new AttestVerificationError('assertion signature verification failed');
  }

  if (parsed.signCounter <= options.storedCounter) {
    throw new AttestVerificationError(
      `sign counter not increasing: stored=${options.storedCounter}, received=${parsed.signCounter}`,
    );
  }

  const normalizedKeyId = normalizeKeyId(options.keyId);
  return {
    env: 'production',
    signCounter: parsed.signCounter,
    keyId: normalizedKeyId,
  };
}

export async function verifyAttestationForEnv(
  env: AttestEnv,
  input: { attestation: string; keyId: string; challenge: Uint8Array; trustAnchorDer?: Uint8Array },
): Promise<AttestationVerifyResult> {
  return verifyAttestationObject({
    attestation: input.attestation,
    keyId: input.keyId,
    challenge: input.challenge,
    appId: requireAppId(env),
    allowedEnvs: allowedEnvironments(env),
    trustAnchorDer: input.trustAnchorDer,
  });
}

export function bindClientData(
  clientData: string,
  challenge: string,
  challengeBytes: Uint8Array,
): Uint8Array {
  const trimmed = clientData.trim();
  if (!trimmed) {
    throw new AttestVerificationError('clientData is required');
  }
  if (trimmed === challenge) {
    return challengeBytes;
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeFlexibleBase64(trimmed);
  } catch {
    decoded = new TextEncoder().encode(trimmed);
  }
  if (bytesEqual(decoded, challengeBytes)) {
    return decoded;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decoded)) as { challenge?: unknown };
    if (typeof parsed.challenge === 'string' && parsed.challenge === challenge) {
      return decoded;
    }
  } catch {
    // Not JSON; fall through.
  }
  throw new AttestVerificationError('clientData does not bind the consumed challenge');
}
