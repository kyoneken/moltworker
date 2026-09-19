/**
 * Environment bindings for the App Attest Worker (`moltworker-attest`).
 *
 * This worker is deliberately separate from the OpenClaw sandbox worker so
 * `/v1/*` never initializes a container, hits Cloudflare Access middleware,
 * or falls through to the gateway proxy.
 */
export interface AttestEnv {
  ATTEST_KV: KVNamespace;

  /** Team ID + bundle ID, e.g. `CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot`. */
  APP_ATTEST_APP_ID: string;

  /** HS256 secret used to mint `mw_attest_session` cookies. */
  ATTEST_SESSION_SECRET: string;

  /**
   * Cookie Domain attribute. Use `.kentymyty.com` in production so
   * `moltbot.kentymyty.com` can receive the cookie. Leave empty for host-only
   * cookies (local `wrangler dev`).
   */
  ATTEST_COOKIE_DOMAIN?: string;

  /** Override cookie name. Defaults to `mw_attest_session`. */
  ATTEST_COOKIE_NAME?: string;

  /** `true` / `false`. Defaults to Secure except when DEV_MODE=true. */
  ATTEST_COOKIE_SECURE?: string;

  /** Challenge TTL in seconds. Defaults to 120. */
  ATTEST_CHALLENGE_TTL_SECONDS?: string;

  /** Session TTL in seconds. Defaults to 43200 (12 hours). */
  ATTEST_SESSION_TTL_SECONDS?: string;

  /**
   * Comma-separated App Attest environments to accept:
   * `sandbox`, `production`. Defaults to both.
   */
  APP_ATTEST_ALLOWED_ENVIRONMENTS?: string;

  /**
   * Cloudflare Access team domain used to verify External Evaluation JWTs
   * (with or without `https://`).
   */
  CF_ACCESS_TEAM_DOMAIN?: string;

  /**
   * Optional audience check for incoming External Evaluation JWTs.
   * Leave unset to accept any audience (Cloudflare's example worker).
   */
  ATTEST_ACCESS_AUD?: string;

  /** Set to `true` for local HTTP cookie + looser logging. */
  DEV_MODE?: string;

  /**
   * Optional PEM trust anchor used instead of Apple's App Attest root.
   * Tests and local synthetic fixtures set this; production must omit it.
   */
  ATTEST_TRUST_ANCHOR_PEM?: string;

  /**
   * Optional local JWKS JSON used instead of the Access certs URL.
   * Tests set this; production must omit it so evaluation JWTs are verified
   * against the team domain.
   */
  ATTEST_ACCESS_LOCAL_JWKS?: string;
}

export type AttestAppEnv = {
  Bindings: AttestEnv;
};

export type AppAttestEnvironment = 'sandbox' | 'production';

export interface StoredChallenge {
  challenge: string;
  createdAt: string;
}

export interface StoredCredential {
  keyId: string;
  publicKey: string;
  signCounter: number;
  env: AppAttestEnvironment;
  updatedAt: string;
}

export interface StoredSession {
  jti: string;
  keyId: string;
  env: AppAttestEnvironment;
  exp: number;
}

export interface AttestationVerifyResult {
  publicKeySpki: Uint8Array;
  env: AppAttestEnvironment;
  signCounter: number;
  keyId: string;
}

export interface AssertionVerifyResult {
  env: AppAttestEnvironment;
  signCounter: number;
  keyId: string;
}
