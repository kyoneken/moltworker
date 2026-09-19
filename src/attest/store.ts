import {
  ACCESS_SIGNING_KEY_KV,
  CHALLENGE_BYTES,
  CHALLENGE_ID_BYTES,
  SESSION_LATEST_KV,
  challengeKey,
  challengeTtlSeconds,
  credentialKey,
  sessionKey,
  sessionTtlSeconds,
} from './config';
import { bytesToBase64url, randomBytes } from './encoding';
import type { AttestEnv, StoredChallenge, StoredCredential, StoredSession } from './types';

export async function issueChallenge(
  env: AttestEnv,
): Promise<{ challengeId: string; challenge: string }> {
  const challengeId = bytesToBase64url(randomBytes(CHALLENGE_ID_BYTES));
  const challenge = bytesToBase64url(randomBytes(CHALLENGE_BYTES));
  const record: StoredChallenge = {
    challenge,
    createdAt: new Date().toISOString(),
  };
  await env.ATTEST_KV.put(challengeKey(challengeId), JSON.stringify(record), {
    expirationTtl: challengeTtlSeconds(env),
  });
  return { challengeId, challenge };
}

export async function consumeChallenge(
  env: AttestEnv,
  challengeId: string,
): Promise<StoredChallenge> {
  const key = challengeKey(challengeId);
  const record = await env.ATTEST_KV.get<StoredChallenge>(key, 'json');
  if (!record?.challenge) {
    throw new Error('challenge not found or expired');
  }
  await env.ATTEST_KV.delete(key);
  return record;
}

export async function putCredential(env: AttestEnv, credential: StoredCredential): Promise<void> {
  await env.ATTEST_KV.put(credentialKey(credential.keyId), JSON.stringify(credential));
}

export async function getCredential(
  env: AttestEnv,
  keyId: string,
): Promise<StoredCredential | null> {
  return env.ATTEST_KV.get<StoredCredential>(credentialKey(keyId), 'json');
}

export function assertMonotonicCounter(stored: number, received: number): void {
  if (!Number.isSafeInteger(received) || received < 0) {
    throw new Error('invalid sign counter');
  }
  if (received <= stored) {
    throw new Error(`sign counter not increasing: stored=${stored}, received=${received}`);
  }
}

export async function putSession(env: AttestEnv, session: StoredSession): Promise<void> {
  const ttl = sessionTtlSeconds(env);
  await env.ATTEST_KV.put(sessionKey(session.jti), JSON.stringify(session), {
    expirationTtl: ttl,
  });
  await env.ATTEST_KV.put(SESSION_LATEST_KV, JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

export async function getSession(env: AttestEnv, jti: string): Promise<StoredSession | null> {
  return env.ATTEST_KV.get<StoredSession>(sessionKey(jti), 'json');
}

export async function getLatestSession(env: AttestEnv): Promise<StoredSession | null> {
  return env.ATTEST_KV.get<StoredSession>(SESSION_LATEST_KV, 'json');
}

export interface AccessSigningKeyset {
  kid: string;
  public: JsonWebKey;
  private: JsonWebKey;
}

export async function loadOrCreateAccessSigningKeys(env: AttestEnv): Promise<AccessSigningKeyset> {
  const existing = await env.ATTEST_KV.get<AccessSigningKeyset>(ACCESS_SIGNING_KEY_KV, 'json');
  if (existing?.kid && existing.public && existing.private) {
    return existing;
  }

  const keypair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keypair.privateKey);
  const kid = bytesToBase64url(randomBytes(16));
  const keyset: AccessSigningKeyset = { kid, public: publicKey, private: privateKey };
  await env.ATTEST_KV.put(ACCESS_SIGNING_KEY_KV, JSON.stringify(keyset));
  return keyset;
}
