import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudflarePlan, DOCS_URL, OBSERVABILITY_URL } from '../../scripts/harness/cloudflare.mjs';

test('base exposes Docs and observability is opt-in', () => {
  const base = cloudflarePlan({ target: 'codex' });
  assert.deepEqual(base.servers.map((server) => server.url), [DOCS_URL]);
  const optional = cloudflarePlan({ target: 'codex', profile: 'observability' });
  assert.deepEqual(optional.servers.map((server) => server.url), [DOCS_URL, OBSERVABILITY_URL]);
});

test('unmanaged servers are preserved and same-name conflicts stop', () => {
  const existing = { custom: { url: 'https://example.test/mcp' }, 'cloudflare-docs': { url: DOCS_URL } };
  assert.equal(cloudflarePlan({ target: 'codex', existing }).servers.length, 0);
  assert.equal(cloudflarePlan({ target: 'codex', existing: { 'cloudflare-docs': { url: 'https://wrong.test/mcp' } } }).reason, 'conflict');
});
