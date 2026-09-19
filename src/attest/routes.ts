import { Hono } from 'hono';
import { allowedEnvironments, cookieName, requireAppId } from './config';
import { base64urlToBytes, bytesToBase64url, normalizeKeyId } from './encoding';
import { consumeChallenge, getCredential, issueChallenge, putCredential } from './store';
import { mintSession } from './session';
import { handleEvaluateRequest, publicJwks } from './access';
import {
  AttestVerificationError,
  bindClientData,
  verifyAssertionObject,
  verifyAttestationObject,
} from './verify';
import { appleAppAttestRootDer, pemToDer } from './apple-root';
import type { AttestAppEnv, AttestEnv } from './types';

export const attestRoutes = new Hono<AttestAppEnv>();

/** Stable substring `unknown keyId` so iOS can clear Keychain and re-attest. */
export const UNKNOWN_KEY_ID_ERROR = 'unknown keyId; device is not attested';

function jsonError(
  c: { json: (data: unknown, status: number) => Response },
  error: unknown,
  fallbackStatus = 400,
): Response {
  const message = error instanceof Error ? error.message : 'request failed';
  const status = error instanceof AttestVerificationError ? 401 : fallbackStatus;
  return c.json({ error: message }, status);
}

function requireConfigured(env: AttestEnv): void {
  requireAppId(env);
  if (!env.ATTEST_SESSION_SECRET?.trim()) {
    throw new Error('ATTEST_SESSION_SECRET is not configured');
  }
}

attestRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltworker-attest',
    appIdConfigured: Boolean(c.env.APP_ATTEST_APP_ID?.trim()),
  });
});

attestRoutes.get('/challenge', async (c) => {
  try {
    requireConfigured(c.env);
    const issued = await issueChallenge(c.env);
    return c.json(issued);
  } catch (error) {
    return jsonError(c, error, 500);
  }
});

attestRoutes.post('/attest', async (c) => {
  try {
    requireConfigured(c.env);
    const body = (await c.req.json()) as {
      challengeId?: string;
      keyId?: string;
      attestation?: string;
    };
    if (!body.challengeId || !body.keyId || !body.attestation) {
      return c.json({ error: 'challengeId, keyId, and attestation are required' }, 400);
    }
    const challenge = await consumeChallenge(c.env, body.challengeId);
    const verified = await verifyAttestationObject({
      attestation: body.attestation,
      keyId: body.keyId,
      challenge: base64urlToBytes(challenge.challenge),
      appId: requireAppId(c.env),
      allowedEnvs: allowedEnvironments(c.env),
      trustAnchorDer: c.env.ATTEST_TRUST_ANCHOR_PEM
        ? pemToDer(c.env.ATTEST_TRUST_ANCHOR_PEM)
        : appleAppAttestRootDer(),
    });
    const credential = {
      keyId: verified.keyId,
      publicKey: bytesToBase64url(verified.publicKeySpki),
      signCounter: verified.signCounter,
      env: verified.env,
      updatedAt: new Date().toISOString(),
    };
    await putCredential(c.env, credential);
    const session = await mintSession(c.env, { keyId: verified.keyId, envName: verified.env });
    c.header('Set-Cookie', session.cookie);
    return c.json({
      ok: true,
      keyId: verified.keyId,
      env: verified.env,
      cookie: cookieName(c.env),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('challenge')) {
      return jsonError(c, error, 400);
    }
    return jsonError(c, error);
  }
});

attestRoutes.post('/assert', async (c) => {
  try {
    requireConfigured(c.env);
    const body = (await c.req.json()) as {
      keyId?: string;
      challengeId?: string;
      assertion?: string;
      clientData?: string;
    };
    if (!body.keyId || !body.challengeId || !body.assertion || !body.clientData) {
      return c.json({ error: 'keyId, challengeId, assertion, and clientData are required' }, 400);
    }
    const keyId = normalizeKeyId(body.keyId);
    const stored = await getCredential(c.env, keyId);
    if (!stored) {
      return c.json({ error: UNKNOWN_KEY_ID_ERROR }, 401);
    }
    const challenge = await consumeChallenge(c.env, body.challengeId);
    const challengeBytes = base64urlToBytes(challenge.challenge);
    const clientData = bindClientData(body.clientData, challenge.challenge, challengeBytes);
    const verified = await verifyAssertionObject({
      assertion: body.assertion,
      keyId,
      clientData,
      appId: requireAppId(c.env),
      publicKeySpki: base64urlToBytes(stored.publicKey),
      storedCounter: stored.signCounter,
    });
    stored.signCounter = verified.signCounter;
    stored.updatedAt = new Date().toISOString();
    await putCredential(c.env, stored);
    const session = await mintSession(c.env, { keyId: stored.keyId, envName: stored.env });
    c.header('Set-Cookie', session.cookie);
    return c.json({
      ok: true,
      keyId: stored.keyId,
      env: stored.env,
      signCounter: stored.signCounter,
      cookie: cookieName(c.env),
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

attestRoutes.post('/access/evaluate', async (c) => {
  try {
    requireConfigured(c.env);
    const evaluated = await handleEvaluateRequest(c.env, c.req.raw);
    return c.json({ token: evaluated.token });
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

attestRoutes.get('/access/keys', async (c) => {
  try {
    return c.json(await publicJwks(c.env));
  } catch (error) {
    return jsonError(c, error, 500);
  }
});

attestRoutes.get('/access/keys/', async (c) => {
  try {
    return c.json(await publicJwks(c.env));
  } catch (error) {
    return jsonError(c, error, 500);
  }
});
