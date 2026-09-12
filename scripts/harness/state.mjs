import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function statePath(root, target) {
  if (!/^[a-z0-9-]+$/.test(target)) throw new Error('invalid-config');
  const base = resolve(root, '.harness/state');
  const path = resolve(base, `${target}.json`);
  if (!path.startsWith(`${base}/`)) throw new Error('invalid-config');
  return path;
}

async function nonSymlink(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('invalid-config');
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkParents(root) {
  for (const path of [join(root, '.harness'), join(root, '.harness/state')]) {
    const stat = await nonSymlink(path);
    if (stat && !stat.isDirectory()) throw new Error('invalid-config');
  }
}

export async function loadState(root, target) {
  await checkParents(root);
  const path = statePath(root, target);
  const stat = await nonSymlink(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('invalid-config');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid-config'); }
}

export async function saveState(root, target, state) {
  await checkParents(root);
  const path = statePath(root, target);
  const directory = dirname(path);
  const parent = await nonSymlink(directory);
  if (parent && !parent.isDirectory()) throw new Error('invalid-config');
  await mkdir(directory, { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
