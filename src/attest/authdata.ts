import { bytesEqual } from './encoding';
import { AAGUID_PRODUCTION, AAGUID_SANDBOX } from './config';
import type { AppAttestEnvironment } from './types';

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCounter: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  raw: Uint8Array;
}

const AT_FLAG = 0x40;

export function parseAuthenticatorData(
  raw: Uint8Array,
  requireAttestedCredential = false,
): AuthenticatorData {
  if (raw.length < 37) {
    throw new Error('authenticatorData too short');
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const rpIdHash = raw.slice(0, 32);
  const flags = raw[32];
  const signCounter = view.getUint32(33, false);

  if (!requireAttestedCredential && (flags & AT_FLAG) === 0) {
    return { rpIdHash, flags, signCounter, raw };
  }

  if (raw.length < 55) {
    throw new Error('authenticatorData missing attested credential data');
  }
  const aaguid = raw.slice(37, 53);
  const credentialIdLength = view.getUint16(53, false);
  if (raw.length < 55 + credentialIdLength) {
    throw new Error('authenticatorData truncated credential id');
  }
  const credentialId = raw.slice(55, 55 + credentialIdLength);
  return { rpIdHash, flags, signCounter, aaguid, credentialId, raw };
}

export function environmentFromAaguid(aaguid: Uint8Array): AppAttestEnvironment {
  if (bytesEqual(aaguid, AAGUID_SANDBOX)) {
    return 'sandbox';
  }
  if (bytesEqual(aaguid, AAGUID_PRODUCTION)) {
    return 'production';
  }
  throw new Error('unknown App Attest aaguid');
}

export function buildAuthenticatorData(options: {
  rpIdHash: Uint8Array;
  flags: number;
  signCounter: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
}): Uint8Array {
  const hasAttested = options.aaguid && options.credentialId;
  const extra = hasAttested ? 16 + 2 + options.credentialId!.length : 0;
  const raw = new Uint8Array(37 + extra);
  raw.set(options.rpIdHash, 0);
  raw[32] = options.flags;
  new DataView(raw.buffer).setUint32(33, options.signCounter, false);
  if (hasAttested) {
    raw.set(options.aaguid!, 37);
    new DataView(raw.buffer).setUint16(53, options.credentialId!.length, false);
    raw.set(options.credentialId!, 55);
  }
  return raw;
}
