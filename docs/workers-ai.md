# Workers AI Proxy (Free path)

Standalone Cloudflare Worker that exposes an **OpenAI-compatible** chat
completions API backed by the Workers AI binding (`AI`). It is intended for the
**Cloudflare Free plan** (Workers + Workers AI + optional AI Gateway). No
containers, Durable Objects, Browser Rendering, or R2 are required.

| Worker | Config | Script | Role |
|--------|--------|--------|------|
| `moltworker-ai` | `wrangler.ai.jsonc` | `npm run deploy:ai` | OpenAI-compatible Workers AI proxy |
| `moltworker-attest` | `wrangler.attest.jsonc` | `npm run deploy:attest` | App Attest + Access External Evaluation |

The Paid Sandbox / OpenClaw hosting Worker (`wrangler.jsonc`) is **deprecated**
in this fork. Prefer this Worker when you only need inference.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | No auth |
| `GET` | `/v1/models` | Bearer `AI_PROXY_TOKEN` |
| `POST` | `/v1/chat/completions` | Bearer `AI_PROXY_TOKEN` |
| `GET` | `/internal/ai/v1/models` | Same handlers (legacy path) |
| `POST` | `/internal/ai/v1/chat/completions` | Same handlers (legacy path) |

Auth is **fail-closed**: missing or wrong `Authorization: Bearer …` returns
`401`. Requests must include an allowlisted `model` (there is no Admin
session-model / R2 fallback on this Worker).

## Required secrets / vars

Create an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) (Free tier
is enough) and note its gateway id.

```bash
# Bearer secret used by clients
npx wrangler secret put AI_PROXY_TOKEN -c wrangler.ai.jsonc
# openssl rand -hex 32

# Gateway id passed to env.AI.run({ gateway: { id } })
npx wrangler secret put AI_GATEWAY_ID -c wrangler.ai.jsonc
# or set as a plain Worker var named AI_GATEWAY_ID
```

| Name | Type | Required | Purpose |
|------|------|----------|---------|
| `AI` | Binding | Yes | Workers AI (`wrangler.ai.jsonc`) |
| `AI_PROXY_TOKEN` | Secret | Yes | Bearer credential (fail-closed if unset) |
| `AI_GATEWAY_ID` | Secret or var | Yes | AI Gateway id for logging / controls |

Do not commit real tokens. Use `.dev.vars` locally (gitignored).

## Deploy

```bash
npm run deploy:ai
```

Local:

```bash
# .dev.vars
AI_PROXY_TOKEN=replace-with-random-64-hex
AI_GATEWAY_ID=your-gateway-id

npm run dev:ai
```

## Example curl

Replace `WORKER_HOST` and inject the token from a secret manager (avoid putting
secrets in shell history when possible):

```bash
export AI_PROXY_TOKEN="$(op read 'op://…/AI_PROXY_TOKEN')"   # example only
curl -sS "https://WORKER_HOST/v1/chat/completions" \
  -H "Authorization: Bearer ${AI_PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/zai-org/glm-4.7-flash",
    "messages": [{"role":"user","content":"ping"}]
  }'
```

List models:

```bash
curl -sS "https://WORKER_HOST/v1/models" \
  -H "Authorization: Bearer ${AI_PROXY_TOKEN}"
```

Negative checks: omit the Bearer header → `401`; unknown model → `400`.

## Free-plan notes

- **Workers** Free: this Worker has no containers / DO / R2.
- **Workers AI**: subject to Cloudflare Free usage limits; see current pricing.
- **AI Gateway**: Free tier supports logging and basic controls; configure rate /
  spend limits in the dashboard for the gateway named by `AI_GATEWAY_ID`.

Allowlisted models come from `config/workers-ai-models.json` (same registry as
the rest of this repo).
