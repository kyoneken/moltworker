import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { ACCESS_RESPONSE_TTL_SECONDS, accessTeamIssuer, cookieName } from './config';
import { extractNamedCookie, verifySessionToken } from './session';
import { getLatestSession, getSession, loadOrCreateAccessSigningKeys } from './store';
import type { AttestEnv, StoredSession } from './types';

export interface EvaluationClaims {
  nonce?: string;
  identity?: Record<string, unknown>;
  email?: string;
  [key: string]: unknown;
}

export interface EvaluationResult {
  success: boolean;
  iat: number;
  exp: number;
  nonce?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractSessionCookieFromClaims(
  claims: EvaluationClaims,
  name: string,
): string | null {
  const direct = claims.cookie;
  if (typeof direct === 'string') {
    return extractNamedCookie(direct, name) ?? (direct.includes('.') ? direct : null);
  }
  const identity = isRecord(claims.identity) ? claims.identity : null;
  if (identity && typeof identity.cookie === 'string') {
    return extractNamedCookie(identity.cookie, name) ?? identity.cookie;
  }
  const request = isRecord(claims.request) ? claims.request : null;
  const headers =
    request && isRecord(request.headers)
      ? request.headers
      : isRecord(claims.headers)
        ? claims.headers
        : null;
  if (headers) {
    const cookie = headers.cookie ?? headers.Cookie;
    if (typeof cookie === 'string') {
      return extractNamedCookie(cookie, name);
    }
  }
  return null;
}

export async function verifyEvaluationToken(
  env: AttestEnv,
  token: string,
  options: { now?: Date; verifyKey?: CryptoKey } = {},
): Promise<EvaluationClaims> {
  const issuer = accessTeamIssuer(env);
  const audience = env.ATTEST_ACCESS_AUD?.trim();
  const verifyOptions = {
    issuer: options.verifyKey ? undefined : (issuer ?? undefined),
    audience: audience || undefined,
    currentDate: options.now,
  };

  if (options.verifyKey) {
    const { payload } = await jwtVerify(token, options.verifyKey, verifyOptions);
    return payload as EvaluationClaims;
  }
  if (env.ATTEST_ACCESS_LOCAL_JWKS) {
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(JSON.parse(env.ATTEST_ACCESS_LOCAL_JWKS) as { keys: JsonWebKey[] }),
      verifyOptions,
    );
    return payload as EvaluationClaims;
  }
  if (!issuer) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN is not configured');
  }
  const { payload } = await jwtVerify(
    token,
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    verifyOptions,
  );
  return payload as EvaluationClaims;
}

export async function hasValidAttestSession(
  env: AttestEnv,
  request: Request,
  claims: EvaluationClaims,
): Promise<{ allowed: boolean; reason: string; session?: StoredSession }> {
  const name = cookieName(env);
  const cookie =
    extractNamedCookie(request.headers.get('Cookie'), name) ??
    extractSessionCookieFromClaims(claims, name);

  if (cookie) {
    try {
      const sessionClaims = await verifySessionToken(env, cookie);
      const stored = await getSession(env, sessionClaims.jti);
      if (!stored) {
        return { allowed: false, reason: 'session cookie is valid but not present in KV' };
      }
      return { allowed: true, reason: 'session cookie verified', session: stored };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : 'session cookie verification failed',
      };
    }
  }

  const latest = await getLatestSession(env);
  const now = Math.floor(Date.now() / 1000);
  if (latest && latest.exp > now) {
    return {
      allowed: true,
      reason: 'associated KV session is unexpired (Access did not forward mw_attest_session)',
      session: latest,
    };
  }
  return { allowed: false, reason: 'no valid App Attest session' };
}

export async function signEvaluationResponse(
  env: AttestEnv,
  result: EvaluationResult,
): Promise<string> {
  const keyset = await loadOrCreateAccessSigningKeys(env);
  const privateKey = await importJWK(keyset.private, 'RS256');
  return new SignJWT({
    success: result.success,
    nonce: result.nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyset.kid, typ: 'JWT' })
    .setIssuedAt(result.iat)
    .setExpirationTime(result.exp)
    .sign(privateKey);
}

export async function publicJwks(env: AttestEnv): Promise<{ keys: JWK[] }> {
  const keyset = await loadOrCreateAccessSigningKeys(env);
  const pub = { ...keyset.public } as JWK;
  delete pub.d;
  delete pub.p;
  delete pub.q;
  delete pub.dp;
  delete pub.dq;
  delete pub.qi;
  return { keys: [{ ...pub, kid: keyset.kid, use: 'sig', alg: 'RS256' }] };
}

export async function handleEvaluateRequest(
  env: AttestEnv,
  request: Request,
  options: { now?: Date; verifyKey?: CryptoKey } = {},
): Promise<{ token: string; result: EvaluationResult; reason: string }> {
  const body = (await request.json()) as { token?: string };
  if (!body?.token) {
    throw new Error('missing evaluation token');
  }
  const claims = await verifyEvaluationToken(env, body.token, options);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const result: EvaluationResult = {
    success: false,
    iat: now,
    exp: now + ACCESS_RESPONSE_TTL_SECONDS,
    nonce: typeof claims.nonce === 'string' ? claims.nonce : undefined,
  };
  const decision = await hasValidAttestSession(env, request, claims);
  result.success = decision.allowed;
  const token = await signEvaluationResponse(env, result);
  return { token, result, reason: decision.reason };
}
