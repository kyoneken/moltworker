import { fakeProviderOutput } from './helpers.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { makeRoot, read, removeRoot, runHarness, write } from './helpers.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture({ malformed = false } = {}) {
  const root = await makeRoot();
  roots.push(root);
  const source = join(root, 'private source with spaces');
  const manifest = 'targets: [codex, claude, cursor, grok-build, antigravity]\n';
  await write(root, 'private source with spaces/apm.yml', manifest);
  await write(root, 'harness/source-lock.json', JSON.stringify({
    schemaVersion: 1,
    repository: 'kyoneken/coding-agent-harness',
    ref: 'f26054f6256e10a107d800d2023defa94f2f71a7',
    apmVersion: '0.29.0',
    files: [{ path: 'apm.yml', sha256: sha256(manifest) }],
  }));
  await write(root, '.codex/settings.json', JSON.stringify({ policy: { keep: true } }));
  const output = malformed ? '{not-json' : JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'policy' }] }] } });
  await write(root, 'fake-apm.mjs', `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('APM 0.29.0'); process.exit(0); }
if (args[0] === 'compile') { process.exit(0); }
const target = args[args.indexOf('--target') + 1];
const paths = { codex: '.codex/hooks.json', claude: '.claude/settings.json', cursor: '.cursor/settings.json', 'grok-build': '.grok/settings.json', antigravity: '.agents/settings.json' };
const path = join(process.cwd(), paths[target]);
mkdirSync(join(path, '..'), { recursive: true });
writeFileSync(path, ${JSON.stringify(output)});
`);
  await appendFile(join(root, 'fake-apm.mjs'), fakeProviderOutput);
  await chmod(join(root, 'fake-apm.mjs'), 0o755);
  return { root, source, env: { HARNESS_APM_COMMAND: join(root, 'fake-apm.mjs'), HARNESS_GROK_COMMAND: '/usr/bin/true' } };
}

test('clean fixture supports all targets through bootstrap, rebootstrap, and restore', async () => {
  for (const target of ['codex', 'claude', 'cursor', 'grok-build', 'antigravity']) {
    const { root, source, env } = await fixture();
    const first = await runHarness(['bootstrap', '--target', target, '--source', source], { root, env });
    assert.equal(first.code, 0, `${target}: ${first.stderr}`);
    const second = await runHarness(['bootstrap', '--target', target, '--source', source], { root, env });
    assert.equal(second.code, 0, `${target} rebootstrap: ${second.stdout} ${second.stderr}`);
    const configPath = { codex: '.codex/config.toml', claude: '.mcp.json', cursor: '.cursor/mcp.json', 'grok-build': '.grok/config.toml', antigravity: '.agents/mcp.json' }[target];
    const config = target === 'antigravity' ? '' : await read(root, configPath);
    if (target !== 'antigravity') assert.match(config, /docs\.mcp\.cloudflare\.com\/mcp/);
    const restored = await runHarness(['restore', '--target', target], { root, env });
    assert.equal(restored.code, 0, `${target} restore: ${restored.stdout} ${restored.stderr}`);
    assert.match(await read(root, '.codex/settings.json'), /policy/);
    await assert.rejects(() => read(root, configPath), /ENOENT/, `${target} generated config remained`);
  }
});

test('observability profile adds the second remote server without credentials', async () => {
  const { root, source, env } = await fixture();
  const result = await runHarness(['bootstrap', '--target', 'codex', '--profile', 'observability', '--source', source], { root, env });
  assert.equal(result.code, 0, result.stderr);
  const config = await read(root, '.codex/config.toml');
  assert.match(config, /docs\.mcp\.cloudflare\.com\/mcp/);
  assert.match(config, /observability\.mcp\.cloudflare\.com\/mcp/);
  assert.doesNotMatch(config, /token|secret|api[_-]?key/i);
});

test('malformed generated configuration fails without a partial write', async () => {
  const { root, source, env } = await fixture({ malformed: true });
  const before = await read(root, '.codex/settings.json');
  const result = await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /invalid-config/);
  assert.equal(await read(root, '.codex/settings.json'), before);
});

test('restore detects a manual edit instead of deleting it', async () => {
  const { root, source, env } = await fixture();
  assert.equal((await runHarness(['bootstrap', '--target', 'codex', '--source', source], { root, env })).code, 0);
  await write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [], manual: true } }));
  const result = await runHarness(['restore', '--target', 'codex'], { root, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /conflict/);
  assert.match(await read(root, '.codex/hooks.json'), /manual/);
});
