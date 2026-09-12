import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adaptCursorHooks } from '../../scripts/harness/cursor.mjs';

test('Cursor adapter converts APM hooks to the documented lower-camel schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cursor-adapter-'));
  try {
    await writeFile(join(root, '.cursor-hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard' }] }] } }));
    await mkdir(join(root, '.cursor'), { recursive: true });
    await import('node:fs/promises').then(({ rename }) => rename(join(root, '.cursor-hooks.json'), join(root, '.cursor/hooks.json')));
    await adaptCursorHooks({ root });
    const config = JSON.parse(await readFile(join(root, '.cursor/hooks.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.equal(config.hooks.preToolUse[0].command, 'node scripts/harness/cursor-adapter.mjs');
    assert.equal(config.hooks.preToolUse[0].matcher, 'Shell');
    assert.equal(config.hooks.beforeMCPExecution[0].failClosed, true);
    await adaptCursorHooks({ root });
    const repeated = JSON.parse(await readFile(join(root, '.cursor/hooks.json'), 'utf8'));
    assert.equal(repeated.hooks.preToolUse.filter((entry) => entry.command === 'node scripts/harness/cursor-adapter.mjs').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Cursor adapter normalizes Shell and GitHub MCP events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cursor-runtime-'));
  try {
    await mkdir(join(root, '.cursor/hooks/coding-agent-harness/scripts'), { recursive: true });
    await writeFile(join(root, '.cursor/hooks/coding-agent-harness/scripts/secret-command-guard.sh'), '#!/bin/sh\nexit 0\n');
    const adapter = fileURLToPath(new URL('../../scripts/harness/cursor-adapter.mjs', import.meta.url));
    const run = (event) => spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
    assert.equal(JSON.parse(run({ tool_name: 'Shell', tool_input: { command: 'git status' } }).stdout).permission, 'allow');
    assert.equal(JSON.parse(run({ tool_name: 'Shell', tool_input: { command: 'gh pr create' } }).stdout).permission, 'deny');
    assert.equal(JSON.parse(run({ mcp_server_name: 'github', tool_name: 'get_file_contents', tool_input: '{}' }).stdout).permission, 'allow');
    assert.equal(JSON.parse(run({ mcp_server_name: 'github', tool_name: 'mcp__github__get_file_contents', tool_input: {} }).stdout).permission, 'allow');
    assert.equal(JSON.parse(run({ mcp_server_name: 'github', tool_name: 'get_file_contents', tool_input: '{' }).stdout).permission, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});
