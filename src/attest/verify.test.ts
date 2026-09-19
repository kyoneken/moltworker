import { describe, expect, it } from 'vitest';
import { AAGUID_PRODUCTION, AAGUID_SANDBOX } from './config';
import { derEcdsaToRaw, encodeOid, rawEcdsaToDer, decodeOid } from './asn1';
import { decodeCbor, encodeCbor } from './cbor';
import { bytesEqual, encodeUtf8, sha256 } from './encoding';
import { bindClientData, verifyAssertionObject, verifyAttestationObject } from './verify';
import { environmentFromAaguid, parseAuthenticatorData, buildAuthenticatorData } from './authdata';
import { createSyntheticAssertion, createSyntheticAttestation } from './fixtures';

const APP_ID = 'CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot';

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
});
