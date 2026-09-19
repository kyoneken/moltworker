import { SignJWT, jwtVerify } from 'jose';
import { cookieDomain, cookieName, cookieSecure, sessionTtlSeconds } from './config';
import { encodeUtf8, randomBytes, bytesToBase64url } from './encoding';
import { putSession } from './store';
import type { AppAttestEnvironment, AttestEnv, StoredSession } from './types';

export interface SessionClaims {
  jti: string;
  keyId: string;
  env: AppAttestEnvironment;
  iat: number;
  exp: number;
}

function sessionSecretBytes(env: AttestEnv): Uint8Array {
  const secret = env.ATTEST_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('ATTEST_SESSION_SECRET must be at least 32 characters');
  }
  return encodeUtf8(secret);
}

export async function mintSession(
  env: AttestEnv,
  options: { keyId: string; envName: AppAttestEnvironment; now?: Date },
): Promise<{ token: string; session: StoredSession; cookie: string }> {
  const now = options.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const ttl = sessionTtlSeconds(env);
  const exp = iat + ttl;
  const jti = bytesToBase64url(randomBytes(16));
  const token = await new SignJWT({
    keyId: options.keyId,
    env: options.envName,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(sessionSecretBytes(env));

  const session: StoredSession = {
    jti,
    keyId: options.keyId,
    env: options.envName,
    exp,
  };
  await putSession(env, session);
  return { token, session, cookie: serializeSessionCookie(env, token, ttl) };
}

export async function verifySessionToken(env: AttestEnv, token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, sessionSecretBytes(env), {
    algorithms: ['HS256'],
  });
  const keyId = typeof payload.keyId === 'string' ? payload.keyId : '';
  const attestEnv = payload.env === 'sandbox' || payload.env === 'production' ? payload.env : null;
  if (!payload.jti || !keyId || !attestEnv || typeof payload.exp !== 'number') {
    throw new Error('session token missing required claims');
  }
  return {
    jti: payload.jti,
    keyId,
    env: attestEnv,
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: payload.exp,
  };
}

export function serializeSessionCookie(
  env: AttestEnv,
  token: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${cookieName(env)}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=Lax`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookieSecure(env)) {
    parts.push('Secure');
  }
  const domain = cookieDomain(env);
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  return parts.join('; ');
}

export function extractNamedCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}
