import type { AppAttestEnvironment, AttestEnv } from './types';

export const DEFAULT_COOKIE_NAME = 'mw_attest_session';
export const DEFAULT_CHALLENGE_TTL_SECONDS = 120;
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ACCESS_RESPONSE_TTL_SECONDS = 60;
export const ACCESS_SIGNING_KEY_KV = 'access_signing_keys';
export const SESSION_LATEST_KV = 'session:latest';

export const CHALLENGE_BYTES = 32;
export const CHALLENGE_ID_BYTES = 16;

/** Production AAGUID: ASCII `appattest` followed by seven 0x00 bytes. */
export const AAGUID_PRODUCTION = new Uint8Array([
  0x61, 0x70, 0x70, 0x61, 0x74, 0x74, 0x65, 0x73, 0x74, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** Development / sandbox AAGUID: ASCII `appattestdevelop`. */
export const AAGUID_SANDBOX = new Uint8Array([
  0x61, 0x70, 0x70, 0x61, 0x74, 0x74, 0x65, 0x73, 0x74, 0x64, 0x65, 0x76, 0x65, 0x6c, 0x6f, 0x70,
]);

export const APPLE_NONCE_OID = '1.2.840.113635.100.8.2';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function challengeTtlSeconds(env: AttestEnv): number {
  return parsePositiveInt(env.ATTEST_CHALLENGE_TTL_SECONDS, DEFAULT_CHALLENGE_TTL_SECONDS);
}

export function sessionTtlSeconds(env: AttestEnv): number {
  return parsePositiveInt(env.ATTEST_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS);
}

export function cookieName(env: AttestEnv): string {
  return env.ATTEST_COOKIE_NAME?.trim() || DEFAULT_COOKIE_NAME;
}

export function cookieDomain(env: AttestEnv): string | undefined {
  const domain = env.ATTEST_COOKIE_DOMAIN?.trim();
  return domain ? domain : undefined;
}

export function cookieSecure(env: AttestEnv): boolean {
  if (env.ATTEST_COOKIE_SECURE === 'false') {
    return false;
  }
  if (env.ATTEST_COOKIE_SECURE === 'true') {
    return true;
  }
  return env.DEV_MODE !== 'true';
}

export function requireAppId(env: AttestEnv): string {
  const appId = env.APP_ATTEST_APP_ID?.trim();
  if (!appId) {
    throw new Error('APP_ATTEST_APP_ID is not configured');
  }
  return appId;
}

export function allowedEnvironments(env: AttestEnv): Set<AppAttestEnvironment> {
  const raw = env.APP_ATTEST_ALLOWED_ENVIRONMENTS?.trim();
  if (!raw) {
    return new Set(['sandbox', 'production']);
  }
  const allowed = new Set<AppAttestEnvironment>();
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase();
    if (value === 'sandbox' || value === 'production') {
      allowed.add(value);
    }
  }
  return allowed.size > 0 ? allowed : new Set(['sandbox', 'production']);
}

export function accessTeamIssuer(env: AttestEnv): string | null {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) {
    return null;
  }
  return teamDomain.startsWith('https://') ? teamDomain : `https://${teamDomain}`;
}

export function challengeKey(challengeId: string): string {
  return `chal:${challengeId}`;
}

export function credentialKey(keyId: string): string {
  return `cred:${keyId}`;
}

export function sessionKey(jti: string): string {
  return `sess:${jti}`;
}
