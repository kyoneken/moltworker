import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, afterEach } from 'node:test';
import { makeRoot, removeRoot, runHarness, write } from './helpers.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await makeRoot();
  roots.push(root);
  const manifest = 'targets: [codex]\n';
  await write(root, 'harness/vendor/coding-agent-harness/apm.yml', manifest);
  await write(root, 'harness/source-lock.json', JSON.stringify({ schemaVersion: 1, repository: 'kyoneken/coding-agent-harness', ref: 'f26054f6256e10a107d800d2023defa94f2f71a7', apmVersion: '0.29.0', files: [{ path: 'apm.yml', sha256: sha256(manifest) }] }));
  return root;
}

test('source verifies the default locked cache without running APM', async () => {
  const root = await fixture();
  const output = await runHarness(['source', '--target', 'codex'], { root });
  assert.equal(output.code, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).checks[0].component, 'source');
});

test('source mismatch points to the tracked vendor source', async () => {
  const root = await makeRoot();
  roots.push(root);
  await write(root, 'harness/source-lock.json', JSON.stringify({ schemaVersion: 1, repository: 'kyoneken/coding-agent-harness', ref: 'f26054f6256e10a107d800d2023defa94f2f71a7', apmVersion: '0.29.0', files: [{ path: 'apm.yml', sha256: sha256('name: test\\n') }] }));
  const output = await runHarness(['source', '--target', 'codex'], { root });
  assert.equal(output.code, 1);
  assert.match(output.stdout, /tracked vendor directory/);
});

test('legacy wrapper commands are rejected so APM remains the visible setup path', async () => {
  const root = await fixture();
  for (const command of ['bootstrap', 'restore']) {
    const output = await runHarness([command, '--target', 'codex'], { root });
    assert.equal(output.code, 1);
    assert.match(output.stdout, /invalid-config/);
  }
  await assert.rejects(() => import('node:fs/promises').then(({ readFile }) => readFile(`${root}/.harness/state/codex.json`)), /ENOENT/);
});

test('CLI rejects duplicate, unknown, positional, and value-less options without exposing them', async () => {
  const root = await fixture();
  for (const args of [
    ['verify', '--target', 'codex', '--target', 'claude'],
    ['source', '--target', 'codex', '--unknown', 'secret-value'],
    ['source', '--target', 'codex', '--source'],
    ['doctor', '--target', 'codex', 'secret-value'],
  ]) {
    const output = await runHarness(args, { root });
    assert.equal(output.code, 1);
    assert.match(output.stdout, /invalid-config/);
    assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /secret-value/);
  }
});
