import { fakeProviderOutput } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRoot, removeRoot, read, readManagedConfiguration, readUnmanagedConfiguration, runHarness, write } from './helpers.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await makeRoot();
  roots.push(root);
  const source = join(root, 'private-source');
  const manifest = 'targets: [codex, claude, cursor, grok-build, antigravity]\n';
  await write(root, 'private-source/apm.yml', manifest);
  await write(root, 'harness/source-lock.json', JSON.stringify({
    schemaVersion: 1,
    repository: 'kyoneken/coding-agent-harness',
    ref: 'f26054f6256e10a107d800d2023defa94f2f71a7',
    apmVersion: '0.29.0',
    files: [{ path: 'apm.yml', sha256: sha256(manifest) }],
  }));
  await write(root, '.codex/settings.json', JSON.stringify({ existingPolicy: { keep: true } }));
  await write(root, 'fake-apm.mjs', `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('APM 0.29.0'); process.exit(0); }\nif (args[0] === 'compile') { process.exit(0); }\nconst target = args[args.indexOf('--target') + 1];\nconst paths = { codex: '.codex/hooks.json', claude: '.claude/settings.json', cursor: '.cursor/settings.json', 'grok-build': '.grok/settings.json', antigravity: '.agents/settings.json' };\nconst path = join(process.cwd(), paths[target]);\nmkdirSync(join(path, '..'), { recursive: true });\nwriteFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'policy' }] }] } }));\n`);
  await appendFile(join(root, 'fake-apm.mjs'), fakeProviderOutput);
  await chmod(join(root, 'fake-apm.mjs'), 0o755);
  return { root, source, env: { HARNESS_APM_COMMAND: join(root, 'fake-apm.mjs'), HARNESS_GROK_COMMAND: '/usr/bin/true' } };
}

test('bootstrap applies only an owned JSON key and is idempotent', async () => {
  const { root, source, env } = await fixture();
  const before = await readUnmanagedConfiguration(root);

  const first = await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });
  assert.equal(first.code, 0, first.stderr);
  const once = await readManagedConfiguration(root);
  await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });

  assert.deepEqual(await readManagedConfiguration(root), once);
  assert.deepEqual(await readUnmanagedConfiguration(root), before);
});

test('bootstrap supports each target as a single selection', async () => {
  for (const target of ['codex', 'claude', 'cursor', 'grok-build', 'antigravity']) {
    const { root, source, env } = await fixture();
    const result = await runHarness(['bootstrap', '--target', target, '--source', source], { root, env });
    assert.equal(result.code, 0, `${target}: ${result.stderr}`);
  }
});

test('bootstrap rejects a modified fixed-SHA source before changing configuration', async () => {
  const { root, source, env } = await fixture();
  await write(root, 'private-source/apm.yml', 'tampered\n');
  const result = await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /source-mismatch/);
  assert.equal(await read(root, '.codex/settings.json'), JSON.stringify({ existingPolicy: { keep: true } }));
});

test('bootstrap rejects an existing non-owned key collision without revealing its value', async () => {
  const { root, source, env } = await fixture();
  await write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: 'secret-value' } }));
  const result = await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /conflict/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-value/);
});

test('bootstrap does not adopt an identical non-owned managed key', async () => {
  const { root, source, env } = await fixture();
  await write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'policy' }] }] } }));
  const result = await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /conflict/);
});

test('restore refuses to overwrite a human change to an owned delta', async () => {
  const { root, source, env } = await fixture();
  assert.equal((await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env })).code, 0);
  await write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [], human: true } }));
  const result = await runHarness(['restore', '--target', 'codex'], { root });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /conflict/);
  assert.match(await read(root, '.codex/hooks.json'), /human/);
});
