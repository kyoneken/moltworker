import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';

const LOCKED_REPOSITORY = 'kyoneken/coding-agent-harness';
const LOCKED_APM_VERSION = '0.29.0';

function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !normalize(path).startsWith('..') && relative('.', path) === path;
}

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function filesBelow(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('symlink');
    if (stat.isDirectory()) files.push(...await filesBelow(root, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error('unsupported file');
  }
  return files;
}

export async function verifySource(sourceDir, lock) {
  if (!lock || lock.schemaVersion !== 1 || lock.repository !== LOCKED_REPOSITORY || lock.apmVersion !== LOCKED_APM_VERSION || !Array.isArray(lock.files) || lock.files.length === 0 || !/^[0-9a-f]{40}$/.test(lock.ref ?? '')) {
    return { ok: false, reason: 'invalid-config' };
  }
  const paths = new Set();
  for (const file of lock.files) {
    if (!safeRelativePath(file?.path) || !/^[0-9a-f]{64}$/.test(file?.sha256 ?? '') || paths.has(file.path)) return { ok: false, reason: 'invalid-config' };
    paths.add(file?.path);
  }
  try {
    const rootStat = await lstat(sourceDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: 'source-mismatch' };
    const actual = await filesBelow(sourceDir);
    if (actual.length !== paths.size || actual.some((path) => !paths.has(path))) return { ok: false, reason: 'source-mismatch' };
  } catch {
    return { ok: false, reason: 'source-mismatch' };
  }
  for (const file of lock.files) {
    try {
      const stat = await lstat(join(sourceDir, file.path));
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: 'source-mismatch' };
      if (hash(await readFile(join(sourceDir, file.path))) !== file.sha256) return { ok: false, reason: 'source-mismatch' };
    } catch {
      return { ok: false, reason: 'source-mismatch' };
    }
  }
  return { ok: true };
}
