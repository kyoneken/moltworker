import { describe, expect, it } from 'vitest';
import { AAGUID_PRODUCTION, AAGUID_SANDBOX } from './config';
import { derEcdsaToRaw, encodeOid, rawEcdsaToDer, decodeOid } from './asn1';
import { decodeCbor, encodeCbor, encodeCborMap } from './cbor';
import {
  bytesEqual,
  bytesToBase64,
  bytesToBase64url,
  decodeFlexibleBase64,
  encodeUtf8,
  sha256,
} from './encoding';
import {
  ASSERTION_PAYLOAD_ERROR,
  bindClientData,
  verifyAssertionObject,
  verifyAttestationObject,
} from './verify';
import { environmentFromAaguid, parseAuthenticatorData, buildAuthenticatorData } from './authdata';
import { createSyntheticAssertion, createSyntheticAttestation } from './fixtures';

const APP_ID = 'CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot';

function thrownMessage(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected function to throw');
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

describe('CBOR and ASN.1 helpers', () => {
  it('round-trips maps, byte strings, and text', () => {
    const encoded = encodeCbor({
      fmt: 'apple-appattest',
      authData: Uint8Array.of(1, 2, 3),
    });
    const decoded = decodeCbor(encoded) as { fmt: string; authData: Uint8Array };
    expect(decoded.fmt).toBe('apple-appattest');
    expect(Array.from(decoded.authData)).toEqual([1, 2, 3]);
  });

  it('throws when a declared byte-string length extends past the buffer', () => {
    // Major type 2, additional 5: claims 5 payload bytes, only 2 follow.
    expect(() => decodeCbor(Uint8Array.of(0x45, 0x01, 0x02))).toThrow(
      /truncated CBOR byte string \(expected 5 bytes at offset 1, available 2\)/,
    );
  });

  it('throws when a declared text-string length extends past the buffer', () => {
    // Major type 3, additional 4: claims 4 UTF-8 bytes, only 1 follows.
    expect(() => decodeCbor(Uint8Array.of(0x64, 0x61))).toThrow(
      /truncated CBOR text string \(expected 4 bytes at offset 1, available 1\)/,
    );
  });

  it('throws when the root value is followed by trailing bytes', () => {
    const encoded = encodeCbor({ fmt: 'apple-appattest' });
    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    trailing[encoded.length] = 0x00;
    expect(() => decodeCbor(trailing)).toThrow(
      new RegExp(`trailing CBOR bytes \\(next=${encoded.length}, length=${trailing.length}\\)`),
    );
  });

  it('throws at CBOR decode when last-map authData is truncated (does not clamp to 37 + AT)', () => {
    const authData = buildAuthenticatorData({
      rpIdHash: new Uint8Array(32).fill(9),
      flags: 0x40,
      signCounter: 0,
      aaguid: AAGUID_PRODUCTION,
      credentialId: new Uint8Array(32).fill(8),
    });
    expect(authData.length).toBeGreaterThan(37);
    expect(authData[32] & 0x40).toBe(0x40);

    const encoded = encodeCbor({
      fmt: 'apple-appattest',
      attStmt: { x5c: [Uint8Array.of(1)] },
      authData,
    });
    const truncated = encoded.subarray(0, encoded.length - (authData.length - 37));
    const message = thrownMessage(() => decodeCbor(truncated));
    expect(message).toMatch(
      /truncated CBOR byte string \(expected \d+ bytes at offset \d+, available 37\)/,
    );
    expect(message).not.toMatch(/missing attested credential data/);
    expect(message).not.toMatch(/authData\.length=37/);
  });

  it('converts ECDSA DER signatures to raw P1363 and back', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[32] = 0x7f;
    const der = rawEcdsaToDer(raw);
    expect(der[0]).toBe(0x30);
    const roundTrip = derEcdsaToRaw(der);
    expect(bytesEqual(roundTrip, raw)).toBe(true);
  });

  it('encodes Apple nonce OID 1.2.840.113635.100.8.2', () => {
    const encoded = encodeOid('1.2.840.113635.100.8.2');
    expect(decodeOid(encoded.slice(2))).toBe('1.2.840.113635.100.8.2');
  });
});

describe('authenticator data', () => {
  it('parses rpIdHash, counter, aaguid, and credential id', async () => {
    const rpIdHash = await sha256(encodeUtf8(APP_ID));
    const credentialId = new Uint8Array(32).fill(9);
    const raw = buildAuthenticatorData({
      rpIdHash,
      flags: 0x41,
      signCounter: 7,
      aaguid: AAGUID_SANDBOX,
      credentialId,
    });
    const parsed = parseAuthenticatorData(raw, true);
    expect(parsed.signCounter).toBe(7);
    expect(bytesEqual(parsed.rpIdHash, rpIdHash)).toBe(true);
    expect(environmentFromAaguid(parsed.aaguid!)).toBe('sandbox');
    expect(bytesEqual(parsed.credentialId!, credentialId)).toBe(true);
  });

  it('maps production aaguid separately from sandbox', () => {
    expect(environmentFromAaguid(AAGUID_PRODUCTION)).toBe('production');
    expect(environmentFromAaguid(AAGUID_SANDBOX)).toBe('sandbox');
  });

  it('describes short assertion-shaped authData when attested credential is required', () => {
    const raw = buildAuthenticatorData({
      rpIdHash: new Uint8Array(32).fill(1),
      flags: 0x01,
      signCounter: 0,
    });
    expect(raw.length).toBe(37);
    expect(() => parseAuthenticatorData(raw, true)).toThrow(
      /authenticatorData missing attested credential data \(authData\.length=37, flags=0x01, AT=false\)/,
    );
  });

  it('includes AT=true when the flag is set but the buffer is still truncated', () => {
    const raw = buildAuthenticatorData({
      rpIdHash: new Uint8Array(32).fill(2),
      flags: 0x41,
      signCounter: 0,
    });
    expect(raw.length).toBe(37);
    expect(() => parseAuthenticatorData(raw, true)).toThrow(
      /authData\.length=37, flags=0x41, AT=true/,
    );
  });
});

describe('flexible base64', () => {
  it('round-trips large standard and base64url payloads without truncation', () => {
    const bytes = new Uint8Array(12 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (i * 37 + 11) & 0xff;
    }
    const standard = bytesToBase64(bytes);
    const wrapped = (standard.match(/.{1,64}/g) ?? [standard]).join('\n');
    expect(decodeFlexibleBase64(wrapped)).toEqual(bytes);
    expect(decodeFlexibleBase64(`  ${bytesToBase64url(bytes)}  `)).toEqual(bytes);
  });
});

describe('clientData challenge binding', () => {
  it('accepts the issued challenge string or JSON that embeds it', () => {
    const challenge = 'abc123challenge';
    const challengeBytes = encodeUtf8('raw-challenge-bytes');
    expect(bindClientData(challenge, challenge, challengeBytes)).toEqual(challengeBytes);

    const json = JSON.stringify({ challenge, extra: true });
    const bound = bindClientData(json, challenge, challengeBytes);
    expect(new TextDecoder().decode(bound)).toBe(json);
  });

  it('rejects clientData that does not include the challenge', () => {
    expect(() => bindClientData('other', 'abc', encodeUtf8('abc'))).toThrow(/does not bind/);
  });
});

describe('synthetic attestation and assertion verification', () => {
  it('verifies a sandbox attestation chained to a test root', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID, environment: 'sandbox' });
    const result = await verifyAttestationObject({
      attestation: fixture.attestation,
      keyId: fixture.keyId,
      challenge: fixture.challenge,
      appId: APP_ID,
      allowedEnvs: new Set(['sandbox', 'production']),
      trustAnchorDer: fixture.rootDer,
    });
    expect(result.env).toBe('sandbox');
    expect(result.keyId).toBe(fixture.keyId);
    expect(result.signCounter).toBe(0);
  });

  it('verifies a production aaguid attestation', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID, environment: 'production' });
    const result = await verifyAttestationObject({
      attestation: fixture.attestation,
      keyId: fixture.keyId,
      challenge: fixture.challenge,
      appId: APP_ID,
      allowedEnvs: new Set(['production']),
      trustAnchorDer: fixture.rootDer,
    });
    expect(result.env).toBe('production');
  });

  it('rejects an rpIdHash that does not match the configured App ID', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID });
    await expect(
      verifyAttestationObject({
        attestation: fixture.attestation,
        keyId: fixture.keyId,
        challenge: fixture.challenge,
        appId: 'AAAA000000.com.example.wrong',
        allowedEnvs: new Set(['sandbox']),
        trustAnchorDer: fixture.rootDer,
      }),
    ).rejects.toThrow(/rpIdHash/);
  });

  it('rejects a challenge that was not bound into the nonce', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID });
    await expect(
      verifyAttestationObject({
        attestation: fixture.attestation,
        keyId: fixture.keyId,
        challenge: new Uint8Array(32).fill(7),
        appId: APP_ID,
        allowedEnvs: new Set(['sandbox']),
        trustAnchorDer: fixture.rootDer,
      }),
    ).rejects.toThrow(/nonce/);
  });

  it('verifies an assertion and enforces a monotonic counter', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID });
    const attested = await verifyAttestationObject({
      attestation: fixture.attestation,
      keyId: fixture.keyId,
      challenge: fixture.challenge,
      appId: APP_ID,
      allowedEnvs: new Set(['sandbox']),
      trustAnchorDer: fixture.rootDer,
    });
    const assertion = await createSyntheticAssertion({
      appId: APP_ID,
      device: fixture.device,
      clientData: fixture.challenge,
      signCounter: 3,
    });
    const verified = await verifyAssertionObject({
      assertion,
      keyId: fixture.keyId,
      clientData: fixture.challenge,
      appId: APP_ID,
      publicKeySpki: attested.publicKeySpki,
      storedCounter: 0,
    });
    expect(verified.signCounter).toBe(3);

    await expect(
      verifyAssertionObject({
        assertion,
        keyId: fixture.keyId,
        clientData: fixture.challenge,
        appId: APP_ID,
        publicKeySpki: attested.publicKeySpki,
        storedCounter: 3,
      }),
    ).rejects.toThrow(/not increasing/);
  });

  it('verifies attestations whose CBOR map uses CTAP2 integer keys 1/2/3', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID, environment: 'sandbox' });
    const decoded = decodeCbor(decodeFlexibleBase64(fixture.attestation)) as {
      fmt: string;
      authData: Uint8Array;
      attStmt: { x5c: Uint8Array[]; receipt: Uint8Array };
    };
    const integerKeyed = encodeCborMap([
      [1, decoded.fmt],
      [2, decoded.authData],
      [3, decoded.attStmt],
    ]);
    const result = await verifyAttestationObject({
      attestation: bytesToBase64url(integerKeyed),
      keyId: fixture.keyId,
      challenge: fixture.challenge,
      appId: APP_ID,
      allowedEnvs: new Set(['sandbox']),
      trustAnchorDer: fixture.rootDer,
    });
    expect(result.keyId).toBe(fixture.keyId);
    expect(result.env).toBe('sandbox');
  });

  it('rejects an assertion CBOR payload posted as an attestation', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID });
    const assertion = await createSyntheticAssertion({
      appId: APP_ID,
      device: fixture.device,
      clientData: fixture.challenge,
      signCounter: 1,
    });
    await expect(
      verifyAttestationObject({
        attestation: assertion,
        keyId: fixture.keyId,
        challenge: fixture.challenge,
        appId: APP_ID,
        allowedEnvs: new Set(['sandbox']),
        trustAnchorDer: fixture.rootDer,
      }),
    ).rejects.toThrow(ASSERTION_PAYLOAD_ERROR);
  });

  it('includes authData diagnostics when attestation authData is assertion-sized', async () => {
    const authData = buildAuthenticatorData({
      rpIdHash: new Uint8Array(32).fill(3),
      flags: 0x01,
      signCounter: 0,
    });
    const attestation = bytesToBase64url(
      encodeCbor({
        fmt: 'apple-appattest',
        authData,
        attStmt: { x5c: [Uint8Array.of(1)] },
      }),
    );
    await expect(
      verifyAttestationObject({
        attestation,
        keyId: bytesToBase64url(new Uint8Array(32).fill(9)),
        challenge: new Uint8Array(32).fill(4),
        appId: APP_ID,
        allowedEnvs: new Set(['sandbox']),
      }),
    ).rejects.toThrow(
      /authenticatorData missing attested credential data \(authData\.length=37, flags=0x01, AT=false\); attestationDecodedBytes=\d+, keys=\[fmt,authData,attStmt\], fmt\.size=15, attStmt\.size=\d+, authData\.size=37/,
    );
  });

  it('rejects truncated last-field authData at CBOR decode, not the 37-byte AT parser', async () => {
    const authData = buildAuthenticatorData({
      rpIdHash: new Uint8Array(32).fill(9),
      flags: 0x40,
      signCounter: 0,
      aaguid: AAGUID_PRODUCTION,
      credentialId: new Uint8Array(32).fill(8),
    });
    const encoded = encodeCbor({
      fmt: 'apple-appattest',
      attStmt: { x5c: [Uint8Array.of(1)] },
      authData,
    });
    const truncated = encoded.subarray(0, encoded.length - (authData.length - 37));
    const message = await rejectionMessage(
      verifyAttestationObject({
        attestation: bytesToBase64url(truncated),
        keyId: bytesToBase64url(new Uint8Array(32).fill(9)),
        challenge: new Uint8Array(32).fill(4),
        appId: APP_ID,
        allowedEnvs: new Set(['production']),
      }),
    );
    expect(message).toMatch(
      /truncated CBOR byte string \(expected \d+ bytes at offset \d+, available 37\)/,
    );
    expect(message).toMatch(/attestationDecodedBytes=/);
    expect(message).not.toMatch(/missing attested credential data/);
    expect(message).not.toMatch(/authData\.length=37/);
  });
});
