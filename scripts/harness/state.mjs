import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function loadState(root, target) {
  try { return JSON.parse(await readFile(join(root, '.harness/state', `${target}.json`), 'utf8')); } catch { return null; }
}

export async function saveState(root, target, state) {
  const path = join(root, '.harness/state', `${target}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
