/**
 * App Attest verification worker.
 *
 * Deployed separately from the OpenClaw sandbox worker so challenge/attest/
 * assertion and Access External Evaluation endpoints never initialize a
 * container or fall through to the gateway proxy.
 *
 * Config: wrangler.attest.jsonc
 * Hostname: https://attest.kentymyty.com
 */
import { Hono } from 'hono';
import { attestRoutes } from './routes';
import type { AttestAppEnv } from './types';

const app = new Hono<AttestAppEnv>();

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  console.log(`[attest] ${c.req.method} ${url.pathname}`);
  await next();
});

app.route('/v1', attestRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));

export default {
  fetch: app.fetch,
};

export { app as attestApp };
