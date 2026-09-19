import { decodeCbor } from './cbor';
import { allowedEnvironments, requireAppId } from './config';
import {
  bytesEqual,
  bytesToBase64url,
  concatBytes,
  decodeFlexibleBase64,
  normalizeKeyId,
  sha256,
} from './encoding';
import { environmentFromAaguid, parseAuthenticatorData } from './authdata';
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

export async function verifyAttestationObject(
  options: VerifyAttestationOptions,
): Promise<AttestationVerifyResult> {
  const decoded = asObject(decodeCbor(decodeFlexibleBase64(options.attestation)));
  if (decoded.fmt !== 'apple-appattest') {
    throw new AttestVerificationError(`unexpected attestation fmt: ${String(decoded.fmt)}`);
  }
  const attStmt = asObject(decoded.attStmt);
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
  const authData = asBytes(decoded.authData, 'authData');
  const parsed = parseAuthenticatorData(authData, true);
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
  const decoded = asObject(decodeCbor(decodeFlexibleBase64(options.assertion)));
  const signature = asBytes(decoded.signature, 'signature');
  const authenticatorData = asBytes(decoded.authenticatorData, 'authenticatorData');
  const parsed = parseAuthenticatorData(authenticatorData, false);

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
