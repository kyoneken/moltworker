import { findPython, runPython } from './python.mjs';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadState, saveState } from './state.mjs';
import { applyOperations, restoreOperations } from './operations.mjs';
import { onepasswordPlan } from './onepassword.mjs';
import { cloudflarePlan } from './cloudflare.mjs';
import { planNativeOperations } from './native.mjs';

export const TARGETS = ['codex', 'claude', 'cursor', 'grok-build', 'antigravity'];
const APM_VERSION = '0.29.0';
const APM_TIMEOUT_MS = 20_000;
const jsonMcpPath = { claude: '.mcp.json', cursor: '.cursor/mcp.json' };
const tomlMcpPath = { codex: '.codex/config.toml', 'grok-build': '.grok/config.toml' };

function run(command, args, cwd, timeoutMs = APM_TIMEOUT_MS) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 4096) stdout += chunk; });
    // Consume stderr, but never surface its potentially-sensitive contents.
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); done({ ok: false, stdout: '' }); });
    child.once('exit', (code) => { clearTimeout(timer); done({ ok: code === 0, stdout }); });
  });
}

async function readText(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid-config');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeAncestors(root, relativePath) {
  const base = resolve(root);
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${base}/`)) throw new Error('invalid-config');
  let current = base;
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid-config');
    } catch (error) { if (error?.code === 'ENOENT') break; throw error; }
  }
}

async function filesBelow(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('invalid-config');
    if (stat.isDirectory()) files.push(...await filesBelow(root, path));
    else if (stat.isFile()) files.push({ path, text: await readFile(join(root, path), 'utf8') });
    else throw new Error('invalid-config');
  }
  return files;
}

async function stage({ sourceDir, target }) {
  const root = await mkdtemp(join(tmpdir(), 'moltworker-harness-stage-'));
  const command = process.env.HARNESS_APM_COMMAND || 'apm';
  try {
    const version = await run(command, ['--version'], root, 5_000);
    if (!version.ok || !new RegExp(`(?:^|\\s)${APM_VERSION.replaceAll('.', '\\.')}(?:\\s+\\([a-f0-9]+\\))?\\s*$`).test(version.stdout.trim())) throw new Error('invalid-config');
    await cp(sourceDir, join(root, 'source'), { recursive: true, dereference: false, errorOnExist: true });
    const onepassword = onepasswordPlan({ target });
    const useApmOnepassword = onepassword.status === 'pass' && target !== 'grok-build';
    const mcp = useApmOnepassword ? `  mcp:\n    - name: ${onepassword.server.name ?? '1password'}\n      registry: false\n      transport: stdio\n      command: ${onepassword.server.command}\n` : '  mcp: []\n';
    await writeFile(join(root, 'apm.yml'), `name: moltworker-harness-stage\nversion: "0.0.0"\ntargets: [${target}]\nincludes: []\ndependencies:\n  apm:\n    - path: './source'\n${mcp}`);
    const installed = await run(command, ['install', '--only', 'apm', '--target', target, '--no-policy'], root);
    const compiled = installed.ok && await run(command, ['compile', '--target', target], root);
    if (!installed.ok || !compiled.ok) throw new Error('invalid-config');
    if (useApmOnepassword && !(await run(command, ['install', '--only', 'mcp', '--target', target, '--no-policy'], root)).ok) throw new Error('invalid-config');
    if (target === 'grok-build' && !(await run(process.env.HARNESS_GROK_COMMAND || 'grok', ['mcp', 'add', '--scope', 'project', '1password', '--', '1password-mcp'], root)).ok) throw new Error('invalid-config');
    return root;
  } catch { await rm(root, { recursive: true, force: true }); return null; }
}

async function projectFilesFor(root, operations) {
  const files = [];
  const base = resolve(root);
  for (const path of new Set(operations.map((operation) => operation.path))) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${base}/`)) throw new Error('invalid-config');
    await assertSafeAncestors(root, path);
    const text = await readText(absolute);
    if (text !== null) files.push({ path, text });
  }
  return files;
}

function sourceDerivedPathOperations(target, generatedFiles) {
  const allowed = target === 'codex'
    ? [/^\.codex\/hooks\/source\//, /^\.codex\/rules\//, /^\.agents\/skills\//]
    : target === 'antigravity' ? [/^\.agents\/skills\//, /^\.agents\/rules\//, /^\.agents\/hooks\/source\//]
      : target === 'claude' ? [/^\.claude\/skills\//, /^\.claude\/rules\//, /^\.claude\/hooks\/source\//]
        : target === 'cursor' ? [/^\.agents\/skills\//, /^\.cursor\/skills\//, /^\.cursor\/rules\//, /^\.cursor\/hooks\/source\//]
          : target === 'grok-build' ? [/^\.grok\/skills\//, /^\.grok\/rules\//] : [];
  return generatedFiles.filter((file) => allowed.some((pattern) => pattern.test(file.path))).map((file) => ({ kind: 'path', path: file.path, desired: file.text }));
}

function stagedOnepasswordOperations(target, generatedFiles) {
  if (target === 'antigravity') return [];
  const path = jsonMcpPath[target] ?? tomlMcpPath[target];
  const generated = generatedFiles.find((file) => file.path === path);
  if (!generated) throw new Error('invalid-config');
  let parsed;
  try {
    if (jsonMcpPath[target]) parsed = JSON.parse(generated.text).mcpServers;
    else {
      const result = runPython('import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read()).get("mcp_servers", {})))', generated.text);
      if (result.status !== 0) throw new Error('invalid-config');
      parsed = JSON.parse(result.stdout);
    }
  } catch { throw new Error('invalid-config'); }
  const entry = parsed?.['1password'];
  // APM emits a registry identifier; it is metadata, not native launch configuration.
  if (entry && typeof entry.id === 'string') delete entry.id;
  if (!entry || onepasswordPlan({ target, existing: { '1password': entry } }).status !== 'pass') throw new Error('invalid-config');
  if (jsonMcpPath[target]) return [{ kind: 'json-key', path, pointer: '/mcpServers/1password', desired: entry }];
  return [{ kind: 'toml-block', path, marker: 'onepassword', desired: '[mcp_servers."1password"]\ncommand = "1password-mcp"\nargs = []' }];
}

function cloudflareOperations(target, profile, projectFiles, previousState) {
  const planned = cloudflarePlan({ target, profile, existing: {} });
  if (planned.status === 'skipped') return [];
  if (planned.status !== 'pass') throw new Error('invalid-config');
  const jsonPath = jsonMcpPath[target];
  if (jsonPath) {
    const file = projectFiles.find((entry) => entry.path === jsonPath);
    if (file) try { if (!JSON.parse(file.text) || Array.isArray(JSON.parse(file.text))) throw new Error('conflict'); } catch (error) { throw error?.message === 'conflict' ? error : new Error('conflict'); }
    return planned.servers.map((server) => ({ kind: 'json-key', path: jsonPath, pointer: `/mcpServers/${server.name}`, desired: { type: 'http', url: server.url } }));
  }
  const tomlPath = tomlMcpPath[target];
  if (!tomlPath) return []; // Antigravity remote project MCP is explicitly unsupported.
  return planned.servers.map((server) => ({ kind: 'toml-block', path: tomlPath, marker: `cloudflare-${server.name}`, desired: `[mcp_servers.${server.name}]\nurl = "${server.url}"` }));
}

export async function planInstall({ root, target, sourceDir, profile = 'base' }) {
  if (!TARGETS.includes(target) || !['base', 'observability'].includes(profile)) return { ok: false, reason: 'invalid-config' };
  if (tomlMcpPath[target]) {
    try { findPython(); } catch { return { ok: false, reason: 'missing-command' }; }
  }
  const staging = await stage({ sourceDir, target });
  if (!staging) return { ok: false, reason: 'invalid-config' };
  try {
    const generatedFiles = await filesBelow(staging);
    const nativePaths = ['.codex/hooks.json', '.agents/hooks.json', '.claude/settings.json', '.cursor/hooks.json'];
    const secretSafetyText = generatedFiles.find((file) => file.path === 'source/.apm/instructions/secret-safety.instructions.md')?.text;
    const native = await planNativeOperations({ target, generatedFiles, secretSafetyText, projectFiles: await projectFilesFor(root, nativePaths.map((path) => ({ path }))) });
    if (native.status === 'fail') return { ok: false, reason: native.reason ?? 'invalid-config' };
    const nativeOperations = native.status === 'skipped' ? [] : native.operations;
    const state = await loadState(root, target);
    const providerFiles = await projectFilesFor(root, [...nativeOperations, ...(jsonMcpPath[target] ? [{ path: jsonMcpPath[target] }] : []), ...(tomlMcpPath[target] ? [{ path: tomlMcpPath[target] }] : [])]);
    const proposed = [...sourceDerivedPathOperations(target, generatedFiles).filter((operation) => !nativeOperations.some((native) => native.kind === 'path' && native.path === operation.path)), ...nativeOperations, ...stagedOnepasswordOperations(target, generatedFiles), ...cloudflareOperations(target, profile, providerFiles, state)];
    // A file created by a prior owned operation remains part of the desired
    // transaction, so reapply can verify ownership instead of adopting it.
    const operations = proposed;
    const files = await projectFilesFor(root, [...operations, ...(state?.operations ?? [])]);
    applyOperations(files, operations, state ?? undefined);
    return { ok: true, root, target, operations };
  } catch (error) { return { ok: false, reason: ['conflict', 'missing-command'].includes(error?.message) ? error.message : 'invalid-config' }; }
  finally { await rm(staging, { recursive: true, force: true }); }
}

async function writeTransaction(root, before, after) {
  const snapshots = new Map(before.map((file) => [file.path, file.text]));
  const changed = new Set([...snapshots.keys(), ...after.map((file) => file.path)]);
  const written = [];
  try {
    for (const path of changed) {
      const next = after.find((file) => file.path === path);
      const absolute = join(root, path);
      await assertSafeAncestors(root, path);
      if (await readText(absolute) !== (snapshots.get(path) ?? null)) throw new Error('conflict');
      if (next?.text === snapshots.get(path)) continue;
      if (!next) { await rm(absolute, { force: true }); written.push(path); continue; }
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.harness-${process.pid}-${Date.now()}`;
      const mode = snapshots.has(path) ? (await lstat(absolute)).mode & 0o777 : 0o600;
      try {
        await writeFile(temporary, next.text, { flag: 'wx', mode });
        await rename(temporary, absolute);
      } finally { await rm(temporary, { force: true }); }
      if (path.endsWith('.sh')) await chmod(absolute, 0o755);
      written.push(path);
    }
  } catch (error) {
    const residual = [];
    for (const path of written.reverse()) try {
      await assertSafeAncestors(root, path);
      const expected = after.find((file) => file.path === path)?.text ?? null;
      if (await readText(join(root, path)) !== expected) { residual.push(path); continue; }
      const old = snapshots.get(path);
      if (old === undefined) await rm(join(root, path), { force: true });
      else await writeFile(join(root, path), old);
    } catch { residual.push(path); }
    throw Object.assign(new Error(['conflict', 'missing-command'].includes(error?.message) ? error.message : 'invalid-config'), { residual });
  }
}

export async function applyInstall(plan) {
  if (!plan.ok) return plan;
  try {
    const state = await loadState(plan.root, plan.target);
    const before = await projectFilesFor(plan.root, [...plan.operations, ...(state?.operations ?? [])]);
    const applied = applyOperations(before, plan.operations, state ?? undefined);
    await writeTransaction(plan.root, before, applied.files);
    try { await saveState(plan.root, plan.target, applied.state); }
    catch (error) { await writeTransaction(plan.root, applied.files, before); return { ok: false, reason: 'invalid-config', residual: error?.residual ?? [] }; }
    return { ok: true };
  } catch (error) { return { ok: false, reason: ['conflict', 'missing-command'].includes(error?.message) ? error.message : 'invalid-config', residual: error?.residual }; }
}

export async function verifyInstall({ root, target }) {
  if (!TARGETS.includes(target)) return { ok: false, reason: 'invalid-config' };
  try {
    const state = await loadState(root, target);
    if (!state) return { ok: false, reason: 'invalid-config' };
    applyOperations(await projectFilesFor(root, state.operations), state.operations, state);
    return { ok: true };
  } catch (error) { return { ok: false, reason: ['conflict', 'missing-command'].includes(error?.message) ? error.message : 'invalid-config' }; }
}

export async function restoreInstall({ root, target }) {
  if (!TARGETS.includes(target)) return { ok: false, reason: 'invalid-config' };
  try {
    const state = await loadState(root, target);
    if (!state) return { ok: false, reason: 'invalid-config' };
    const before = await projectFilesFor(root, [...state.operations, ...(state.previousOperations ?? [])]);
    const restored = restoreOperations(before, state);
    await writeTransaction(root, before, restored.files);
    if (restored.state.operations.length === 0) await rm(join(root, '.harness/state', `${target}.json`), { force: true });
    else await saveState(root, target, restored.state);
    return { ok: true };
  } catch (error) { return { ok: false, reason: ['conflict', 'missing-command'].includes(error?.message) ? error.message : 'invalid-config', residual: error?.residual }; }
}
