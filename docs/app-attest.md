# App Attest Worker

Phase B server for the solo-user iOS pilot. This repository now contains **two
Workers**:

| Worker | Config | Hostname | Role |
|--------|--------|----------|------|
| `moltbot-sandbox` | `wrangler.jsonc` | `moltbot.kentymyty.com` | OpenClaw gateway + admin UI |
| `moltworker-attest` | `wrangler.attest.jsonc` | `attest.kentymyty.com` | Apple App Attest + Access External Evaluation |

The attest service is a **separate Worker** so `/v1/*` never starts a sandbox
container, never runs Cloudflare Access middleware, and never falls through to
the OpenClaw proxy. It only needs Workers + KV (Cloudflare Free is enough for
this service). Do not attach `attest.kentymyty.com` to `moltbot-sandbox`.

Identity (Auth0 email) stays Cloudflare Access's job on
`moltbot.kentymyty.com`. This worker only answers: **did a recent genuine App
Attest session succeed?**

## Architecture

```
iOS app (URLSession)
  POST https://attest.kentymyty.com/v1/challenge
  POST https://attest.kentymyty.com/v1/attest   -> Set-Cookie: mw_attest_session
  POST https://attest.kentymyty.com/v1/assert   -> refresh cookie

WKWebView
  GET  https://moltbot.kentymyty.com/           -> Cloudflare Access
         Auth0 (email) + External Evaluation
           POST https://attest.kentymyty.com/v1/access/evaluate
           GET  https://attest.kentymyty.com/v1/access/keys
```

App ID used for the authenticator `rpIdHash` check (never taken from the
client):

```
CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot
```

That value is `APP_ATTEST_APP_ID` in `wrangler.attest.jsonc`.

## HTTP API

All JSON. Binary fields accept standard Base64 or Base64URL.

### `GET /v1/health`

Smoke check. Does not require secrets.

```json
{ "status": "ok", "service": "moltworker-attest", "appIdConfigured": true }
```

### `GET /v1/challenge`

Issues a one-time 32-byte challenge (KV TTL ~2 minutes).

```json
{ "challengeId": "<base64url>", "challenge": "<base64url>" }
```

iOS must SHA-256-decode `challenge` and pass that hash to
`DCAppAttestService.attestKey` / `generateAssertion`. Do not hash the Base64
string.

### `POST /v1/attest`

```json
{ "challengeId": "...", "keyId": "<base64 or base64url>", "attestation": "<base64 or base64url CBOR>" }
```

Consumes the challenge, verifies the Apple App Attest object, stores
`cred:<keyId>` in KV, and sets `mw_attest_session`.

Verification includes:

- `fmt` is `apple-appattest`
- x5c chain to the pinned Apple App Attest Root CA (or
  `ATTEST_TRUST_ANCHOR_PEM` in tests)
- nonce extension OID `1.2.840.113635.100.8.2` equals
  `SHA256(authData || SHA256(challenge))`
- `authData` rpIdHash equals `SHA256(APP_ATTEST_APP_ID)`
- credential id equals SHA-256 of the uncompressed P-256 point and the supplied
  `keyId`
- aaguid is sandbox (`appattestdevelop`) or production (`appattest` + 7 NUL
  bytes)
- attestation counter is 0

### `POST /v1/assert`

```json
{
  "keyId": "...",
  "challengeId": "...",
  "assertion": "<base64 or base64url CBOR>",
  "clientData": "<base64url challenge, raw challenge bytes, or JSON containing the challenge>"
}
```

`clientData` must bind the consumed challenge (the issued Base64URL string, the
raw challenge bytes, or JSON `{ "challenge": "<issued challenge>" }`). The
server hashes those exact bytes as `clientDataHash`.

Assertion signatures are verified as ECDSA P-256 over
`SHA256(authenticatorData || clientDataHash)` after converting Apple's DER
signature to IEEE P1363 `r||s`. The authenticator sign counter must **strictly
increase**. Replay / non-increasing counters return 401.

Unknown `keyId` returns `401` with `Unknown keyId — device not attested` so the
iOS client can wipe the local key and re-attest.

### Access External Evaluation

Follows the Cloudflare signed request/response contract
([docs](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/external-evaluation/),
[example worker](https://github.com/cloudflare/workers-access-external-auth-example)):

- Evaluate: `POST /v1/access/evaluate` with body `{ "token": "<Access JWT>" }`
- Keys: `GET /v1/access/keys` (trailing slash is also accepted)

The worker verifies the incoming JWT against
`https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, echoes `nonce`, and
returns `{ "token": "<RS256 JWT>" }` with `success`, `iat`, `exp` (~60s), and
`nonce`. Signing keys are generated on first `/keys` or `/evaluate` call and
stored in KV.

Allow when a valid, unexpired `mw_attest_session` is present on the request or
in the evaluation claims, **or** (if Access does not forward cookies) when KV
still holds `session:latest` from a recent attest/assert. An invalid cookie
fails closed even if a latest session exists.

## Cookie / WKWebView sharing

Cookie name: `mw_attest_session`

| Attribute | Production | Local `wrangler dev` |
|-----------|------------|----------------------|
| Domain | `.kentymyty.com` (`ATTEST_COOKIE_DOMAIN`) | omitted (host-only) |
| Secure | yes | no when `DEV_MODE=true` or `ATTEST_COOKIE_SECURE=false` |
| HttpOnly | yes | yes |
| SameSite | Lax | Lax |
| Path | `/` | `/` |
| Max-Age | 12 hours | 12 hours |

Sibling-host sharing: a cookie set by `attest.kentymyty.com` with
`Domain=.kentymyty.com` is sent to `moltbot.kentymyty.com` on top-level
navigations.

**iOS gotcha (client repo, out of scope here):** `URLSession` and `WKWebView`
do **not** share cookies automatically. After native attest, copy
`Set-Cookie` into `WKWebsiteDataStore.default().httpCookieStore` (or the
WebView's store) before loading `https://moltbot.kentymyty.com`. SameSite=Lax
is enough for a top-level WebView navigation; this is not a cross-site XHR
cookie.

## Sandbox vs production

| Build | AAGUID | Stored `env` |
|-------|--------|----------------|
| Development / Simulator-ineligible TestFlight sandbox | `appattestdevelop` | `sandbox` |
| App Store / production App Attest | `appattest` + 7 `0x00` bytes | `production` |

Both are accepted by default (`APP_ATTEST_ALLOWED_ENVIRONMENTS=sandbox,production`).
Restrict later with `production` only.

Device-signed Apple attestation objects are **not** in this repo. Unit tests
use a synthetic P-256 CA plus constructed `authData`. Capture a real
`attestation` / `assertion` from the iOS app against this API before treating
production verification as proven.

## Deploy (do not run from CI without the account)

```bash
# 1. Create KV (once) and paste the id into wrangler.attest.jsonc
npx wrangler kv namespace create ATTEST_KV -c wrangler.attest.jsonc

# 2. Secrets
npx wrangler secret put ATTEST_SESSION_SECRET -c wrangler.attest.jsonc
# openssl rand -hex 32
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN -c wrangler.attest.jsonc
# optional:
# npx wrangler secret put ATTEST_ACCESS_AUD -c wrangler.attest.jsonc

# 3. DNS: in the kentymyty.com zone, attach the Worker custom domain
#    attest.kentymyty.com → moltworker-attest
#    wrangler.attest.jsonc already declares that custom domain.

# 4. Deploy only the attest worker (does not rebuild the sandbox container)
npm run deploy:attest
```

Local:

```bash
# .dev.vars for this worker (wrangler reads it when using -c wrangler.attest.jsonc)
APP_ATTEST_APP_ID=CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot
ATTEST_SESSION_SECRET=replace-with-random-64-hex
DEV_MODE=true
ATTEST_COOKIE_SECURE=false
# leave ATTEST_COOKIE_DOMAIN empty for host-only cookies
npm run start:attest
```

`GET http://127.0.0.1:8787/v1/health` should return `{ "status": "ok" }`.

## Cloudflare Access dashboard

On the **existing** `moltbot.kentymyty.com` Access application (Auth0 email
allowlist unchanged):

1. Zero Trust → Access controls → Policies (or the application's Policies tab).
2. Add a **Require** rule:
   - Selector: **External Evaluation**
   - Evaluate URL: `https://attest.kentymyty.com/v1/access/evaluate`
   - Keys URL: `https://attest.kentymyty.com/v1/access/keys`
3. Keep the Auth0 **Include** email / login-method rules. External Evaluation
   is an extra gate, not a replacement for identity.
4. Hit `GET https://attest.kentymyty.com/v1/access/keys` once so the RS256
   keypair is generated in KV before the first Access login.
5. Confirm `attest.kentymyty.com` itself is **not** behind Access (challenge,
   attest, assert, evaluate, and keys must be reachable by the iOS app and by
   Access).

Do not re-enable mTLS. This External Evaluation rule is the chosen alternative.

## Secrets and vars

| Name | Kind | Purpose |
|------|------|---------|
| `APP_ATTEST_APP_ID` | var | Team ID + bundle ID hashed as rpId |
| `ATTEST_COOKIE_DOMAIN` | var | `.kentymyty.com` in production; empty locally |
| `APP_ATTEST_ALLOWED_ENVIRONMENTS` | var | `sandbox,production` |
| `ATTEST_SESSION_SECRET` | secret | HS256 key for `mw_attest_session` (≥32 chars) |
| `CF_ACCESS_TEAM_DOMAIN` | secret | Verifies incoming evaluation JWTs |
| `ATTEST_ACCESS_AUD` | secret (optional) | Audience check on evaluation JWTs |
| `ATTEST_COOKIE_SECURE` | var (optional) | `true` / `false` |
| `ATTEST_CHALLENGE_TTL_SECONDS` | var (optional) | default `120` |
| `ATTEST_SESSION_TTL_SECONDS` | var (optional) | default `43200` |
| `ATTEST_TRUST_ANCHOR_PEM` | test/dev only | Replace Apple root with a synthetic CA |

Examples (no real secrets) are in `.dev.vars.example`.
