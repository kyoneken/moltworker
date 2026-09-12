import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { TARGETS, targetPlan } from '../../scripts/harness/targets.mjs';
import { cursorAdapter, planNativeOperations } from '../../scripts/harness/native.mjs';

test('each target has an explicit capability mapping', () => {
  assert.deepEqual(TARGETS, ['codex', 'claude', 'cursor', 'grok-build', 'antigravity']);
  for (const target of TARGETS) {
    const plan = targetPlan({ target });
    assert.equal(plan.status, 'pass');
    assert.ok(plan.capabilities.instructions);
    assert.ok(plan.capabilities.skills);
    assert.ok(plan.capabilities.mcp);
  }
  assert.equal(targetPlan({ target: 'claude' }).capabilities.mcpConfig, '.mcp.json');
});

test('Grok and Antigravity limitations remain explicit', () => {
  assert.equal(targetPlan({ target: 'grok-build' }).capabilities.hooks, 'unsupported');
  assert.equal(targetPlan({ target: 'antigravity' }).capabilities.mcp, 'unsupported');
  assert.equal(targetPlan({ target: 'antigravity' }).onepassword, 'incompatible');
  assert.equal(targetPlan({ target: 'unknown' }).reason, 'invalid-config');
});

test('native mapping translates Cursor hooks to its documented flat lower-camel schema', () => {
  const plan = planNativeOperations({ target: 'cursor' });
  assert.equal(plan.status, 'pass');
  const operation = plan.operations.find((entry) => entry.pointer === '/hooks/preToolUse');
  assert.deepEqual(operation, {
    kind: 'json-array',
    path: '.cursor/hooks.json',
    pointer: '/hooks/preToolUse',
    desired: [{
      matcher: 'Shell',
      command: '/usr/bin/env node .harness/generated/cursor-github-policy.mjs',
      timeout: 10,
    }],
  });
  assert.deepEqual(plan.operations.find((entry) => entry.pointer === '/hooks/beforeMCPExecution').desired, [{
    command: '/usr/bin/env node .harness/generated/cursor-github-policy.mjs',
    timeout: 10,
    failClosed: true,
  }]);
  assert.deepEqual(plan.operations.find((entry) => entry.pointer === '/version'), {
    kind: 'json-key', path: '.cursor/hooks.json', pointer: '/version', desired: 1,
  });
});

test('Cursor derives its secret guard path from the staged APM hook command', () => {
  const plan = planNativeOperations({ target: 'cursor', generatedFiles: [{
    path: '.cursor/hooks.json',
    text: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '.cursor/hooks/source/scripts/secret-command-guard.sh' }] }] } }),
  }] });
  assert.match(plan.operations.find((entry) => entry.pointer === '/hooks/preToolUse').desired[0].command, /\.cursor\/hooks\/source\/scripts\/secret-command-guard\.sh/);
});

test('native mapping leaves missing-file creation to the operations engine', () => {
  const plan = planNativeOperations({ target: 'cursor' });
  assert.ok(plan.operations.every((operation) => operation.kind !== 'path' || operation.path !== '.cursor/hooks.json'));
});

test('native mapping keeps Claude hooks separate and records unsupported Antigravity project remote MCP', () => {
  const claude = planNativeOperations({ target: 'claude', generatedFiles: [{
    path: '.claude/settings.json',
    text: JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'secret-guard' }] }] } }),
  }] });
  assert.equal(claude.status, 'pass');
  assert.ok(claude.operations.some((entry) => entry.path === '.claude/settings.json'));
  assert.ok(claude.operations.some((entry) => entry.pointer === '/hooks/PreToolUse' && entry.desired[0].hooks[0].command === 'secret-guard'));

  const antigravity = planNativeOperations({ target: 'antigravity' });
  assert.equal(antigravity.status, 'pass');
  assert.deepEqual(antigravity.remoteMcp, { status: 'skipped', reason: 'incompatible' });
  assert.equal(antigravity.operations.length, 0);
});

test('native mapping preserves the APM Antigravity namespace instead of treating it as a Claude hook', () => {
  const plan = planNativeOperations({ target: 'antigravity', generatedFiles: [{
    path: '.agents/hooks.json',
    text: JSON.stringify({ apm: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard' }] }] } }),
  }] });
  assert.deepEqual(plan.operations, [{
    kind: 'json-array', path: '.agents/hooks.json', pointer: '/apm/PreToolUse',
    desired: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard' }] }],
  }]);
});

test('Codex keeps source-derived secret safety ignored and references it from a bounded public AGENTS block', () => {
  const plan = planNativeOperations({ target: 'codex', secretSafetyText: 'private source-derived instruction' });
  assert.deepEqual(plan.operations, [
    { kind: 'path', path: '.codex/rules/secret-safety.md', desired: 'private source-derived instruction' },
    {
      kind: 'markdown-block', path: 'AGENTS.md', marker: 'harness-codex-secret-safety',
      desired: 'Before running commands that could expose secrets, read `.codex/rules/secret-safety.md`.',
    },
  ]);
});

test('Cursor adapter normalizes Shell and named GitHub MCP inputs without trusting the launch command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cursor-adapter-'));
  const adapter = join(root, 'adapter.mjs');
  const policy = new URL('../../.codex/hooks/github-policy.mjs', import.meta.url);
  await writeFile(adapter, cursorAdapter.replace('../../.codex/hooks/github-policy.mjs', policy.href));
  const run = (input) => spawnSync(process.execPath, [adapter], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(JSON.parse(run({ tool_name: 'Shell', tool_input: { command: 'gh pr create' } }).stdout).permission, 'deny');
  assert.equal(JSON.parse(run({ tool_name: 'Shell', tool_input: { command: 'git status' } }).stdout).permission, 'allow');
  assert.equal(JSON.parse(run({ mcp_server_name: 'github', tool_name: 'get_file_contents', tool_input: JSON.stringify({ owner: 'cloudflare', repo: 'moltworker', path: 'README.md' }) }).stdout).permission, 'allow');
  assert.equal(JSON.parse(run({ mcp_server_name: '1password', tool_name: 'read', tool_input: '{}' }).stdout).permission, 'allow');
  assert.equal(JSON.parse(run({ mcp_server_name: 'github', tool_name: 'get_file_contents', tool_input: '{' }).stdout).permission, 'deny');
  assert.equal(JSON.parse(run({ mcp_server_name: 'unknown', tool_name: 'get_file_contents', tool_input: '{}' }).stdout).permission, 'allow');
  assert.equal(JSON.parse(run({ tool_name: 'Shell', tool_input: { command: 'x'.repeat(70_000) } }).stdout).permission, 'deny');
});

test('native secret guard adapter turns a blocking exit into exit 2', async (t) => {
  const { rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'harness-secret-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = planNativeOperations({ target: 'claude', generatedFiles: [{
    path: '.claude/settings.json', text: JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './secret-command-guard.sh' }] }] } }),
  }] });
  const adapter = plan.operations.find((operation) => operation.kind === 'path');
  assert.ok(adapter);
  await writeFile(join(root, 'adapter.mjs'), adapter.desired);
  const guard = join(root, 'guard.sh');
  for (const [exit, expected] of [[0, 0], [1, 2]]) {
    await writeFile(guard, `#!/bin/sh\nexit ${exit}\n`);
    const result = spawnSync(process.execPath, [join(root, 'adapter.mjs'), guard], { input: '{"tool_input":{"command":"synthetic"}}', encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic/);
  }
});
