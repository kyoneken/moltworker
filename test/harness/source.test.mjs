import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { makeRoot, removeRoot, write } from './helpers.mjs';
import { verifySource } from '../../scripts/harness/source.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

function lockFor(path, contents) {
  return { schemaVersion: 1, repository: 'kyoneken/coding-agent-harness', ref: 'f26054f6256e10a107d800d2023defa94f2f71a7', apmVersion: '0.29.0', files: [{ path, sha256: createHash('sha256').update(contents).digest('hex') }] };
}

test('source verification rejects duplicate lock entries and extra files', async () => {
  const root = await makeRoot();
  roots.push(root);
  const contents = 'name: test\n';
  await write(root, 'source/apm.yml', contents);
  const lock = lockFor('apm.yml', contents);
  assert.deepEqual(await verifySource(join(root, 'source'), { ...lock, files: [lock.files[0], lock.files[0]] }), { ok: false, reason: 'invalid-config' });
  await write(root, 'source/extra.txt', 'extra');
  assert.deepEqual(await verifySource(join(root, 'source'), lock), { ok: false, reason: 'source-mismatch' });
});

test('source verification rejects a lock for another repository or APM version', async () => {
  const root = await makeRoot();
  roots.push(root);
  const contents = 'name: test\n';
  await write(root, 'source/apm.yml', contents);
  const lock = lockFor('apm.yml', contents);
  assert.deepEqual(await verifySource(join(root, 'source'), { ...lock, repository: 'other/repository' }), { ok: false, reason: 'invalid-config' });
  assert.deepEqual(await verifySource(join(root, 'source'), { ...lock, apmVersion: '0.28.0' }), { ok: false, reason: 'invalid-config' });
});

test('source verification rejects a symlinked source tree', async () => {
  const root = await makeRoot();
  roots.push(root);
  const contents = 'name: test\n';
  await write(root, 'real/apm.yml', contents);
  await mkdir(join(root, 'alias-root'), { recursive: true });
  await symlink(join(root, 'real'), join(root, 'alias-root/source'));
  assert.deepEqual(await verifySource(join(root, 'alias-root/source'), lockFor('apm.yml', contents)), { ok: false, reason: 'source-mismatch' });
});

test('source verification rejects traversal and symlinked lock members', async () => {
  const root = await makeRoot();
  roots.push(root);
  const contents = 'name: test\n';
  await write(root, 'source/apm.yml', contents);
  const lock = lockFor('apm.yml', contents);
  assert.deepEqual(await verifySource(join(root, 'source'), { ...lock, files: [{ ...lock.files[0], path: 'dir/../apm.yml' }] }), { ok: false, reason: 'invalid-config' });
  await mkdir(join(root, 'outside'), { recursive: true });
  await symlink(join(root, 'outside'), join(root, 'source/link'));
  assert.deepEqual(await verifySource(join(root, 'source'), lock), { ok: false, reason: 'source-mismatch' });
});
