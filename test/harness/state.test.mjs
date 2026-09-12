import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { makeRoot, removeRoot } from './helpers.mjs';
import { loadState } from '../../scripts/harness/state.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

test('state loading rejects symlinked state files and malformed JSON', async () => {
  const root = await makeRoot();
  roots.push(root);
  await mkdir(join(root, '.harness/state'), { recursive: true });
  await writeFile(join(root, 'elsewhere.json'), '{}');
  await symlink(join(root, 'elsewhere.json'), join(root, '.harness/state/codex.json'));
  await assert.rejects(() => loadState(root, 'codex'), /invalid-config/);
  await writeFile(join(root, '.harness/state/codex.json'), '{invalid');
  await assert.rejects(() => loadState(root, 'codex'), /invalid-config/);
});
