import { describe, expect, it } from 'vitest';
import { mintSession, serializeSessionCookie, verifySessionToken } from './session';
import { createAttestEnv } from './test-utils';

describe('attest session JWT', () => {
  it('mints a verifiable HS256 session and round-trips claims', async () => {
    const env = createAttestEnv();
    const minted = await mintSession(env, { keyId: 'device-key', envName: 'sandbox' });
    const claims = await verifySessionToken(env, minted.token);

    expect(claims.keyId).toBe('device-key');
    expect(claims.env).toBe('sandbox');
    expect(claims.jti).toBe(minted.session.jti);
    expect(claims.exp).toBe(minted.session.exp);
  });

  it('rejects a session signed with a different secret', async () => {
    const env = createAttestEnv();
    const minted = await mintSession(env, { keyId: 'device-key', envName: 'production' });
    const other = createAttestEnv({
      ATTEST_KV: env.ATTEST_KV,
      ATTEST_SESSION_SECRET: 'a-different-session-secret-32bytes!!',
    });
    await expect(verifySessionToken(other, minted.token)).rejects.toThrow(
      /signature verification failed|invalid/i,
    );
  });

  it('serializes an HttpOnly cookie with Domain when configured', () => {
    const env = createAttestEnv({
      ATTEST_COOKIE_DOMAIN: '.kentymyty.com',
      ATTEST_COOKIE_SECURE: 'true',
    });
    const cookie = serializeSessionCookie(env, 'token-value', 43200);
    expect(cookie).toContain('mw_attest_session=token-value');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Domain=.kentymyty.com');
    expect(cookie).toContain('Max-Age=43200');
  });

  it('omits Domain for local host-only cookies', () => {
    const env = createAttestEnv({ ATTEST_COOKIE_DOMAIN: '' });
    const cookie = serializeSessionCookie(env, 'token-value', 60);
    expect(cookie).not.toContain('Domain=');
  });
});
