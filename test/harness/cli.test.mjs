import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRoot, removeRoot, runHarness, write } from './helpers.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await makeRoot();
  roots.push(root);
  const manifest = 'targets: [codex, claude, cursor, grok-build, antigravity]\n';
  await write(root, '.harness/source/coding-agent-harness/apm.yml', manifest);
  const secretSafety = 'Do not print secret values.\n';
  await write(root, '.harness/source/coding-agent-harness/.apm/instructions/secret-safety.instructions.md', secretSafety);
  await write(root, 'harness/source-lock.json', JSON.stringify({
    schemaVersion: 1,
    repository: 'kyoneken/coding-agent-harness',
    ref: 'f26054f6256e10a107d800d2023defa94f2f71a7',
    apmVersion: '0.29.0',
    files: [{ path: '.apm/instructions/secret-safety.instructions.md', sha256: sha256(secretSafety) }, { path: 'apm.yml', sha256: sha256(manifest) }],
  }));
  await write(root, 'fake-apm.mjs', `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('APM 0.29.0'); process.exit(0); }\nif (args[0] === 'compile') { process.exit(0); }\nconst hooks = join(process.cwd(), '.codex/hooks.json');\nmkdirSync(join(hooks, '..'), { recursive: true });\nwriteFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'policy' }] }] } }));\nif (args[0] === 'install' && args.includes('mcp')) writeFileSync(join(process.cwd(), '.codex/config.toml'), '[mcp_servers.\"1password\"]\\ncommand = \"1password-mcp\"\\n');\n`);
  await chmod(join(root, 'fake-apm.mjs'), 0o755);
  return { root, env: { HARNESS_APM_COMMAND: join(root, 'fake-apm.mjs') } };
}

test('bootstrap and verify use the same default source', async () => {
  const { root, env } = await fixture();
  const bootstrap = await runHarness(['bootstrap', '--target', 'codex'], { root, env });
  assert.equal(bootstrap.code, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
  const verify = await runHarness(['verify', '--target', 'codex'], { root, env });
  assert.equal(verify.code, 0, `${verify.stdout}\n${verify.stderr}`);
});

test('CLI rejects duplicate, unknown, and value-less options without exposing arguments', async () => {
  const { root } = await fixture();
  for (const args of [
    ['verify', '--target', 'codex', '--target', 'claude'],
    ['verify', '--target', 'codex', '--unexpected', 'secret-value'],
    ['bootstrap', '--target', 'codex', '--source'],
    ['bootstrap', '--target', 'codex', '--profile', 'secret-value'],
    ['restore', '--target', 'codex', 'secret-value'],
  ]) {
    const output = await runHarness(args, { root });
    assert.equal(output.code, 1, `${args.join(' ')}: ${output.stderr}`);
    assert.match(output.stdout, /invalid-config/);
    assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /secret-value/);
  }
});

test('verify reports manual changes to an installed target', async () => {
  const { root, env } = await fixture();
  const bootstrap = await runHarness(['bootstrap', '--target', 'codex'], { root, env });
  assert.equal(bootstrap.code, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
  await write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [] } }));
  const verify = await runHarness(['verify', '--target', 'codex'], { root, env });
  assert.equal(verify.code, 1);
  assert.match(verify.stdout, /conflict/);
});

test('missing Python is reported with an actionable dependency diagnostic', async () => {
  const { root, env } = await fixture();
  const output = await runHarness(['bootstrap', '--target', 'codex'], { root, env: { ...env, HARNESS_PYTHON_COMMAND: join(root, 'missing-python') } });
  assert.equal(output.code, 1);
  const check = JSON.parse(output.stdout).checks[0];
  assert.equal(check.reason, 'missing-command');
  assert.match(check.nextAction, /Python 3\.11/);
  assert.doesNotMatch(output.stdout + output.stderr, /missing-python/);
});

test('missing source explains locked cache preparation for bootstrap and verify', async () => {
  const { root, env } = await fixture();
  for (const command of ['bootstrap', 'verify']) {
    const output = await runHarness([command, '--target', 'codex', '--source', join(root, 'absent-source')], { root, env });
    assert.equal(output.code, 1);
    const check = JSON.parse(output.stdout).checks[0];
    assert.equal(check.reason, 'source-mismatch');
    assert.match(check.nextAction, /source-lock\.json/);
    assert.match(check.nextAction, /GitHub MCP/);
  }
});
