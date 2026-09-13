import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOOK_PATH = '.cursor/hooks.json';
const ADAPTER_COMMAND = 'node scripts/harness/cursor-adapter.mjs';

async function readConfig(root) {
  const directory = join(root, '.cursor');
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid-config');
  const path = join(root, HOOK_PATH);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid-config');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid-config'); }
}

function commandEntry({ command, failClosed = false } = {}) {
  return { command, timeout: 10, ...(failClosed ? { failClosed: true } : {}) };
}

function hasCommand(entries, command, failClosed) {
  return entries.some((entry) => entry?.command === command && (failClosed === undefined || entry.failClosed === failClosed));
}

export async function adaptCursorHooks({ root } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('invalid-config');
  const config = await readConfig(root);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid-config');
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
  const preToolUse = Array.isArray(hooks.preToolUse) ? [...hooks.preToolUse] : [];
  const beforeMCPExecution = Array.isArray(hooks.beforeMCPExecution) ? [...hooks.beforeMCPExecution] : [];
  if (!hasCommand(preToolUse, ADAPTER_COMMAND)) preToolUse.push({ matcher: 'Shell', ...commandEntry({ command: ADAPTER_COMMAND }) });
  if (!hasCommand(beforeMCPExecution, ADAPTER_COMMAND, true)) beforeMCPExecution.push(commandEntry({ command: ADAPTER_COMMAND, failClosed: true }));
  config.version = 1;
  config.hooks = { ...hooks, preToolUse, beforeMCPExecution };
  const path = join(root, HOOK_PATH);
  const temporary = `${path}.harness-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  return { path: HOOK_PATH, command: ADAPTER_COMMAND };
}
