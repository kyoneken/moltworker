import { generateKeyPair, SignJWT, exportJWK, importJWK, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attestApp } from './index';
import { createAttestEnv } from './test-utils';
import { createSyntheticAssertion, createSyntheticAttestation } from './fixtures';
import { base64urlToBytes, bytesToBase64url } from './encoding';
import { publicJwks } from './access';
import { UNKNOWN_KEY_ID_ERROR } from './routes';
import { ASSERTION_PAYLOAD_ERROR } from './verify';

const APP_ID = 'CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot';

describe('App Attest HTTP API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /v1/health returns ok without secrets', async () => {
    const env = createAttestEnv({ ATTEST_SESSION_SECRET: '' });
    const response = await attestApp.request('https://attest.kentymyty.com/v1/health', {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'moltworker-attest',
    });
  });

  it('issues a challenge and consumes it during attest', async () => {
    const fixture = await createSyntheticAttestation({ appId: APP_ID });
    const env = createAttestEnv({ ATTEST_TRUST_ANCHOR_PEM: fixture.rootPem });

    const challengeResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      env,
    );
    expect(challengeResponse.status).toBe(200);
    const issued = (await challengeResponse.json()) as { challengeId: string; challenge: string };

    const fixtureForIssued = await createSyntheticAttestation({
      appId: APP_ID,
      challenge: base64urlToBytes(issued.challenge),
    });
    const envWithRoot = createAttestEnv({
      ATTEST_KV: env.ATTEST_KV,
      ATTEST_TRUST_ANCHOR_PEM: fixtureForIssued.rootPem,
    });

    const attestResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/attest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: issued.challengeId,
          keyId: fixtureForIssued.keyId,
          attestation: fixtureForIssued.attestation,
        }),
      },
      envWithRoot,
    );
    expect(attestResponse.status).toBe(200);
    const body = (await attestResponse.json()) as { ok: boolean; env: string };
    expect(body.ok).toBe(true);
    expect(body.env).toBe('sandbox');
    expect(attestResponse.headers.get('Set-Cookie')).toContain('mw_attest_session=');

    const replay = await attestApp.request(
      'https://attest.kentymyty.com/v1/attest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: issued.challengeId,
          keyId: fixtureForIssued.keyId,
          attestation: fixtureForIssued.attestation,
        }),
      },
      envWithRoot,
    );
    expect(replay.status).toBe(400);
  });

  it('refreshes the session cookie on a monotonic assertion', async () => {
    const env = createAttestEnv();
    const challengeResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      env,
    );
    const issued = (await challengeResponse.json()) as { challengeId: string; challenge: string };
    const boundFixture = await createSyntheticAttestation({
      appId: APP_ID,
      challenge: base64urlToBytes(issued.challenge),
    });
    const attestEnv = createAttestEnv({
      ATTEST_KV: env.ATTEST_KV,
      ATTEST_TRUST_ANCHOR_PEM: boundFixture.rootPem,
    });
    const attested = await attestApp.request(
      'https://attest.kentymyty.com/v1/attest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: issued.challengeId,
          keyId: boundFixture.keyId,
          attestation: boundFixture.attestation,
        }),
      },
      attestEnv,
    );
    expect(attested.status).toBe(200);

    const assertChallenge = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      attestEnv,
    );
    const next = (await assertChallenge.json()) as { challengeId: string; challenge: string };
    const assertion = await createSyntheticAssertion({
      appId: APP_ID,
      device: boundFixture.device,
      clientData: base64urlToBytes(next.challenge),
      signCounter: 2,
    });
    const asserted = await attestApp.request(
      'https://attest.kentymyty.com/v1/assert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyId: boundFixture.keyId,
          challengeId: next.challengeId,
          assertion,
          clientData: next.challenge,
        }),
      },
      attestEnv,
    );
    expect(asserted.status).toBe(200);
    const assertedBody = (await asserted.json()) as { signCounter: number };
    expect(assertedBody.signCounter).toBe(2);
    expect(asserted.headers.get('Set-Cookie')).toContain('mw_attest_session=');

    const replayed = await attestApp.request(
      'https://attest.kentymyty.com/v1/assert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyId: boundFixture.keyId,
          challengeId: next.challengeId,
          assertion,
          clientData: next.challenge,
        }),
      },
      attestEnv,
    );
    expect(replayed.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /v1/access/keys returns a JWKS set', async () => {
    const env = createAttestEnv();
    const response = await attestApp.request(
      'https://attest.kentymyty.com/v1/access/keys',
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: Array<{ kty: string; kid: string }> };
    expect(body.keys[0].kty).toBe('RSA');
    expect(body.keys[0].kid).toBeTruthy();
  });

  it('POST /v1/access/evaluate allows only with a live App Attest session', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'access-kid';
    publicJwk.alg = 'RS256';
    const env = createAttestEnv({
      ATTEST_ACCESS_LOCAL_JWKS: JSON.stringify({ keys: [publicJwk] }),
    });
    const incoming = await new SignJWT({
      nonce: 'n-http',
      identity: { email: 'pilot@example.com' },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'access-kid' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const denied = await attestApp.request(
      'https://attest.kentymyty.com/v1/access/evaluate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: incoming }),
      },
      env,
    );
    expect(denied.status).toBe(200);
    const deniedBody = (await denied.json()) as { token: string };
    expect(deniedBody.token.split('.')).toHaveLength(3);

    const challengeResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      env,
    );
    const issued = (await challengeResponse.json()) as { challengeId: string; challenge: string };
    const bound = await createSyntheticAttestation({
      appId: APP_ID,
      challenge: base64urlToBytes(issued.challenge),
    });
    await attestApp.request(
      'https://attest.kentymyty.com/v1/attest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: issued.challengeId,
          keyId: bound.keyId,
          attestation: bound.attestation,
        }),
      },
      createAttestEnv({ ATTEST_KV: env.ATTEST_KV, ATTEST_TRUST_ANCHOR_PEM: bound.rootPem }),
    );

    const allowed = await attestApp.request(
      'https://attest.kentymyty.com/v1/access/evaluate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: incoming }),
      },
      env,
    );
    expect(allowed.status).toBe(200);
    const jwks = await publicJwks(env);
    const verifyKey = await importJWK(jwks.keys[0], 'RS256');
    const deniedPayload = await jwtVerify(deniedBody.token, verifyKey);
    expect(deniedPayload.payload.success).toBe(false);
    const allowedBody = (await allowed.json()) as { token: string };
    const allowedPayload = await jwtVerify(allowedBody.token, verifyKey);
    expect(allowedPayload.payload.success).toBe(true);
  });

  it('rejects assertion CBOR posted to /v1/attest with a clear error', async () => {
    const env = createAttestEnv();
    const challengeResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      env,
    );
    const issued = (await challengeResponse.json()) as { challengeId: string; challenge: string };
    const fixture = await createSyntheticAttestation({
      appId: APP_ID,
      challenge: base64urlToBytes(issued.challenge),
    });
    const assertion = await createSyntheticAssertion({
      appId: APP_ID,
      device: fixture.device,
      clientData: base64urlToBytes(issued.challenge),
      signCounter: 1,
    });
    const response = await attestApp.request(
      'https://attest.kentymyty.com/v1/attest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: issued.challengeId,
          keyId: fixture.keyId,
          attestation: assertion,
        }),
      },
      env,
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(ASSERTION_PAYLOAD_ERROR);
  });

  it('returns a recognizable unknown keyId error when the credential was never stored', async () => {
    const env = createAttestEnv();
    const challengeResponse = await attestApp.request(
      'https://attest.kentymyty.com/v1/challenge',
      {},
      env,
    );
    const issued = (await challengeResponse.json()) as { challengeId: string; challenge: string };
    const response = await attestApp.request(
      'https://attest.kentymyty.com/v1/assert',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyId: bytesToBase64url(new Uint8Array(32).fill(7)),
          challengeId: issued.challengeId,
          assertion: bytesToBase64url(new Uint8Array([0xa2])),
          clientData: issued.challenge,
        }),
      },
      env,
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unknown keyId');
    expect(body.error).toBe(UNKNOWN_KEY_ID_ERROR);
  });
});
