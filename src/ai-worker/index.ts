/**
 * Standalone Workers AI proxy (Cloudflare Free path).
 *
 * Exposes the authenticated OpenAI-compatible proxy with the Workers AI
 * binding only — no containers, Durable Objects, Browser Rendering, or R2.
 *
 * Config: wrangler.ai.jsonc
 * Deploy: npm run deploy:ai
 */
import { Hono } from 'hono';
import type { AiProxyAppEnv } from '../ai-proxy/env';
import { createAiProxyRoutes } from '../routes/ai-proxy';

const app = new Hono<AiProxyAppEnv>();

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'moltworker-ai',
    aiBound: typeof c.env.AI !== 'undefined',
  }),
);

// OpenAI-style public paths (preferred for the Free worker).
app.route('/v1', createAiProxyRoutes());

// Legacy internal paths (same handlers as the deprecated sandbox Worker).
app.route('/internal/ai/v1', createAiProxyRoutes());

app.notFound((c) => c.json({ error: 'not found' }, 404));

export default {
  fetch: app.fetch,
};

export { app as aiWorkerApp };
