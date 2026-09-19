import { generateKeyPair, SignJWT, jwtVerify, importJWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleEvaluateRequest,
  hasValidAttestSession,
  publicJwks,
  signEvaluationResponse,
} from './access';
import { mintSession } from './session';
import { createAttestEnv } from './test-utils';

describe('Access External Evaluation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows when a valid session cookie is present', async () => {
    const env = createAttestEnv();
    const minted = await mintSession(env, { keyId: 'key', envName: 'sandbox' });
    const decision = await hasValidAttestSession(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate', {
        headers: { Cookie: minted.cookie.split('; ')[0] },
      }),
      { nonce: 'n1' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/cookie verified/);
  });

  it('allows when Access does not forward the cookie but a KV session exists', async () => {
    const env = createAttestEnv();
    await mintSession(env, { keyId: 'key', envName: 'production' });
    const decision = await hasValidAttestSession(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate'),
      { nonce: 'n1' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/KV session/);
  });

  it('denies when no App Attest session exists', async () => {
    const env = createAttestEnv();
    const decision = await hasValidAttestSession(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate'),
      { nonce: 'n1' },
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies an invalid cookie even if a latest KV session exists', async () => {
    const env = createAttestEnv();
    await mintSession(env, { keyId: 'key', envName: 'sandbox' });
    const decision = await hasValidAttestSession(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate', {
        headers: { Cookie: 'mw_attest_session=not-a-jwt' },
      }),
      { nonce: 'n1' },
    );
    expect(decision.allowed).toBe(false);
  });

  it('signs a response JWT that includes success and nonce', async () => {
    const env = createAttestEnv();
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signEvaluationResponse(env, {
      success: true,
      iat: now,
      exp: now + 60,
      nonce: 'abc123',
    });
    const jwks = await publicJwks(env);
    const key = await importJWK(jwks.keys[0], 'RS256');
    const { payload } = await jwtVerify(jwt, key);
    expect(payload.success).toBe(true);
    expect(payload.nonce).toBe('abc123');
  });

  it('evaluates a signed Access request and returns a signed allow/deny token', async () => {
    const env = createAttestEnv();
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const incoming = await new SignJWT({
      nonce: 'eval-nonce',
      identity: { email: 'pilot@example.com' },
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const denied = await handleEvaluateRequest(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: incoming }),
      }),
      { verifyKey: publicKey },
    );
    expect(denied.result.success).toBe(false);
    expect(denied.result.nonce).toBe('eval-nonce');

    await mintSession(env, { keyId: 'key', envName: 'sandbox' });
    const allowed = await handleEvaluateRequest(
      env,
      new Request('https://attest.kentymyty.com/v1/access/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: incoming }),
      }),
      { verifyKey: publicKey },
    );
    expect(allowed.result.success).toBe(true);
    expect(allowed.result.nonce).toBe('eval-nonce');
  });
});
