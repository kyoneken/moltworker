import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('root APM manifest visibly declares local source and both base MCP servers', async () => {
  const manifest = await readFile(new URL('../../apm.yml', import.meta.url), 'utf8');
  assert.match(manifest, /path:.*harness\/vendor\/coding-agent-harness/);
  assert.match(manifest, /name: 1password/);
  assert.match(manifest, /command: 1password-mcp/);
  assert.match(manifest, /url: https:\/\/docs\.mcp\.cloudflare\.com\/mcp/);
  assert.doesNotMatch(manifest, /observability\.mcp|token:|secret:|headers:/);
});

test('committed APM lock pins the tool version and base MCP deployments', async () => {
  const lock = await readFile(new URL('../../apm.lock.yaml', import.meta.url), 'utf8');
  assert.match(lock, /apm_version: 0\.29\.0/);
  assert.match(lock, /name: 1password/);
  assert.match(lock, /name: cloudflare-docs/);
  for (const target of ['codex', 'claude', 'cursor', 'grok-build', 'antigravity']) {
    assert.match(lock, new RegExp(`target: ${target}`));
  }
});
