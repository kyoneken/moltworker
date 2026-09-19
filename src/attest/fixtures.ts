import { rawEcdsaToDer } from './asn1';
import { AAGUID_PRODUCTION, AAGUID_SANDBOX } from './config';
import { encodeCbor } from './cbor';
import {
  asBufferSource,
  bytesToBase64,
  bytesToBase64url,
  concatBytes,
  randomBytes,
  sha256,
} from './encoding';
import { buildAuthenticatorData } from './authdata';
import { buildP256Certificate } from './x509';
import type { AppAttestEnvironment } from './types';

export async function generateP256Pair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
}

export function derToPem(der: Uint8Array): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

export async function createSyntheticAttestation(options: {
  appId: string;
  environment?: AppAttestEnvironment;
  challenge?: Uint8Array;
  now?: Date;
}): Promise<{
  attestation: string;
  keyId: string;
  challenge: Uint8Array;
  challengeB64url: string;
  device: CryptoKeyPair;
  rootPem: string;
  rootDer: Uint8Array;
}> {
  const now = options.now ?? new Date();
  const challenge = options.challenge ?? randomBytes(32);
  const environment = options.environment ?? 'sandbox';
  const root = await generateP256Pair();
  const device = await generateP256Pair();
  const rawPoint = new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey));
  const credentialId = await sha256(rawPoint);
  const rpIdHash = await sha256(new TextEncoder().encode(options.appId));
  const authData = buildAuthenticatorData({
    rpIdHash,
    flags: 0x41,
    signCounter: 0,
    aaguid: environment === 'production' ? AAGUID_PRODUCTION : AAGUID_SANDBOX,
    credentialId,
  });
  const nonce = await sha256(concatBytes(authData, await sha256(challenge)));
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const rootDer = await buildP256Certificate({
    subjectKey: root.publicKey,
    issuerKey: root.privateKey,
    subjectCn: 'Test App Attest Root',
    issuerCn: 'Test App Attest Root',
    serial: 1,
    notBefore,
    notAfter,
    isCa: true,
  });
  const leafDer = await buildP256Certificate({
    subjectKey: device.publicKey,
    issuerKey: root.privateKey,
    subjectCn: 'Test App Attest Leaf',
    issuerCn: 'Test App Attest Root',
    serial: 2,
    notBefore,
    notAfter,
    nonce,
  });
  const attestation = encodeCbor({
    fmt: 'apple-appattest',
    attStmt: {
      x5c: [leafDer, rootDer],
      receipt: new Uint8Array([1, 2, 3]),
    },
    authData,
  });
  return {
    attestation: bytesToBase64url(attestation),
    keyId: bytesToBase64url(credentialId),
    challenge,
    challengeB64url: bytesToBase64url(challenge),
    device,
    rootPem: derToPem(rootDer),
    rootDer,
  };
}

export async function createSyntheticAssertion(options: {
  appId: string;
  device: CryptoKeyPair;
  clientData: Uint8Array;
  signCounter: number;
}): Promise<string> {
  const rpIdHash = await sha256(new TextEncoder().encode(options.appId));
  const authenticatorData = buildAuthenticatorData({
    rpIdHash,
    flags: 0x01,
    signCounter: options.signCounter,
  });
  const signedMessage = concatBytes(authenticatorData, await sha256(options.clientData));
  const signatureRaw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      options.device.privateKey,
      asBufferSource(signedMessage),
    ),
  );
  return bytesToBase64url(
    encodeCbor({
      signature: rawEcdsaToDer(signatureRaw),
      authenticatorData,
    }),
  );
}
