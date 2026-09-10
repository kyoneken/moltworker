import { access, cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { hashText, loadState, saveState } from './state.mjs';
import { onepasswordPlan } from './onepassword.mjs';
import { cloudflarePlan } from './cloudflare.mjs';

export const TARGETS = ['codex', 'claude', 'cursor', 'grok-build', 'antigravity'];
const hookPath = { codex: ['.codex/hooks.json', 'hooks.PreToolUse'], claude: ['.claude/settings.json', 'hooks.PreToolUse'], cursor: ['.cursor/hooks.json', 'hooks.PreToolUse'], antigravity: ['.agents/hooks.json', 'apm.PreToolUse'] };
const fixturePath = { codex: '.codex/settings.json', claude: '.claude/settings.json', cursor: '.cursor/settings.json', 'grok-build': '.grok/settings.json', antigravity: '.agents/settings.json' };

const APM_VERSION = '0.29.0';
const APM_TIMEOUT_MS = 20_000;

function run(command, args, cwd, timeoutMs = APM_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 4096) stdout += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve({ ok: false, stdout: '' }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout }); });
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

const cloudflareJsonPath = { claude: '.mcp.json', cursor: '.cursor/mcp.json', antigravity: '.agents/mcp.json' };

async function addCloudflareConfig({ root, projectRoot, target, profile }) {
  const jsonPath = cloudflareJsonPath[target];
  if (jsonPath) {
    const projectText = await readText(join(projectRoot, jsonPath));
    const currentText = projectText ?? await readText(join(root, jsonPath));
    let current = {};
    if (currentText !== null) {
      try { current = JSON.parse(currentText); } catch { return false; }
    }
    const planned = cloudflarePlan({ target, profile, existing: current.mcpServers ?? {} });
    if (planned.status !== 'pass') return false;
    current.mcpServers ??= {};
    for (const server of planned.servers) current.mcpServers[server.name] = { type: 'http', url: server.url };
    if (!planned.servers.length && currentText === null) return true;
    await mkdir(dirname(join(root, jsonPath)), { recursive: true });
    await writeFile(join(root, jsonPath), `${JSON.stringify(current, null, 2)}\n`);
    return true;
  }

  const configPath = target === 'codex' ? '.codex/config.toml' : '.grok/config.toml';
  const projectText = await readText(join(projectRoot, configPath));
  const stagedText = await readText(join(root, configPath));
  const currentText = projectText ?? stagedText;
  const text = currentText ?? '';
  const existing = {};
  const sectionPattern = /\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g;
  for (const match of text.matchAll(sectionPattern)) {
    const url = match[2].match(/^url\s*=\s*"([^"]+)"/m)?.[1];
    existing[match[1]] = { url };
  }
  const planned = cloudflarePlan({ target, profile, existing });
  if (planned.status !== 'pass') return false;
  const blocks = planned.servers.map((server) => `\n[mcp_servers.${server.name}]\nurl = "${server.url}"\n`).join('');
  if (blocks || (projectText !== null && stagedText !== projectText)) {
    await mkdir(dirname(join(root, configPath)), { recursive: true });
    await writeFile(join(root, configPath), blocks ? `${text.trimEnd()}${blocks}\n` : text);
  }
  return true;
}

async function filesBelow(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function stage({ sourceDir, target, profile, projectRoot }) {
  const root = await mkdtemp(join(tmpdir(), 'moltworker-harness-stage-'));
  const command = process.env.HARNESS_APM_COMMAND || 'apm';
  const version = await run(command, ['--version'], root, 5_000);
  if (!version.ok || !version.stdout.includes(APM_VERSION)) { await rm(root, { recursive: true, force: true }); return null; }
  await cp(sourceDir, join(root, 'source'), { recursive: true, dereference: false });
  const localPath = './source';
  const onepassword = onepasswordPlan({ target });
  const useApmOnepassword = onepassword.status === 'pass' && target !== 'grok-build';
  const mcp = useApmOnepassword
    ? `  mcp:\n    - name: ${onepassword.server.name ?? '1password'}\n      registry: false\n      transport: stdio\n      command: ${onepassword.server.command}\n`
    : '  mcp: []\n';
  await writeFile(join(root, 'apm.yml'), `name: moltworker-harness-stage\nversion: \"0.0.0\"\ntargets: [${target}]\nincludes: []\ndependencies:\n  apm:\n    - path: '${localPath}'\n${mcp}`);
  const installed = await run(command, ['install', '--only', 'apm', '--target', target, '--no-policy'], root);
  const compiled = installed.ok && await run(command, ['compile', '--target', target], root);
  if (!installed.ok || !compiled.ok) { await rm(root, { recursive: true, force: true }); return null; }
  if (useApmOnepassword) {
    const mcpInstalled = await run(command, ['install', '--only', 'mcp', '--target', target, '--no-policy'], root);
    if (!mcpInstalled.ok) { await rm(root, { recursive: true, force: true }); return null; }
  } else if (target === 'grok-build' && !(await readText(join(root, fixturePath[target])))) {
    const grok = await run(process.env.HARNESS_GROK_COMMAND || 'grok', ['mcp', 'add', '--scope', 'project', '1password', '--', '1password-mcp'], root);
    const config = await readText(join(root, '.grok/config.toml'));
    if (!grok.ok || !config?.includes('1password-mcp')) { await rm(root, { recursive: true, force: true }); return null; }
  }
  if (!(await addCloudflareConfig({ root, projectRoot, target, profile }))) { await rm(root, { recursive: true, force: true }); return null; }
  return root;
}

export async function planInstall({ root, target, sourceDir, profile = 'base' }) {
  if (!TARGETS.includes(target) || !['base', 'observability'].includes(profile)) return { ok: false, reason: 'invalid-config' };
  const staging = await stage({ sourceDir, target, profile, projectRoot: root });
  if (!staging) return { ok: false, reason: 'invalid-config' };
  try {
    const path = hookPath[target]?.[0];
    const fixture = await readJson(join(staging, fixturePath[target]));
    if (Object.hasOwn(fixture, 'harness')) {
      const current = await readJson(join(root, fixturePath[target]));
      const state = await loadState(root, target);
      const desired = fixture.harness;
      if (Object.hasOwn(current, 'harness') && (!state || hashText(JSON.stringify(current.harness)) !== state.operations?.[0]?.afterHash)) return { ok: false, reason: 'conflict' };
      const operations = [{ target, kind: 'json-key', path: fixturePath[target], ownership: 'harness', desired, beforeHash: Object.hasOwn(current, 'harness') ? hashText(JSON.stringify(current.harness)) : null }];
      for (const relativePath of await filesBelow(staging)) {
        const targetPrefix = `.${target === 'grok-build' ? 'grok' : target === 'antigravity' ? 'agents' : target}/`;
        const isClaudeMcp = target === 'claude' && relativePath === '.mcp.json';
        if (relativePath === fixturePath[target] || (!relativePath.startsWith(targetPrefix) && !isClaudeMcp)) continue;
        const stagedPath = join(staging, relativePath);
        const stagedText = await readFile(stagedPath, 'utf8');
        try {
          const currentText = await readFile(join(root, relativePath), 'utf8');
          if (currentText !== stagedText) return { ok: false, reason: 'conflict' };
          const previous = state?.operations?.find((entry) => entry.kind === 'path' && entry.path === relativePath);
          if (previous) operations.push({ target, kind: 'path', path: relativePath, ownership: relativePath, desired: stagedText, beforeHash: previous.beforeHash });
        } catch { operations.push({ target, kind: 'path', path: relativePath, ownership: relativePath, desired: stagedText, beforeHash: null }); }
      }
      return { ok: true, operations };
    }
    const operations = [];
    const previousState = await loadState(root, target);
    for (const relativePath of await filesBelow(staging)) {
      if (!/^(\.codex|\.claude|\.cursor|\.grok|\.agents)\//.test(relativePath)) continue;
      const stagedPath = join(staging, relativePath);
      if (relativePath === hookPath[target]?.[0]) {
        const staged = await readJson(stagedPath);
        if (!Array.isArray(staged.hooks?.PreToolUse)) continue;
        const current = await readJson(join(root, relativePath));
        const [owner, key] = hookPath[target][1].split('.');
        const existing = current[owner]?.[key] ?? [];
        const state = await loadState(root, target);
        const owned = staged.hooks.PreToolUse;
        const alreadyOwned = owned.every((entry) => existing.some((currentEntry) => sameJson(currentEntry, entry)));
        if (alreadyOwned && !state) return { ok: false, reason: 'conflict' };
        operations.push({ target, kind: 'json-array', path: relativePath, ownership: hookPath[target]?.[1] ?? 'hooks.PreToolUse', desired: owned, beforeHash: hashText(JSON.stringify(existing)), beforeExists: await exists(join(root, relativePath)) });
      } else {
        const desired = await readFile(stagedPath, 'utf8');
        try {
          const current = await readFile(join(root, relativePath), 'utf8');
          if (current === desired) {
            const previous = previousState?.operations?.find((entry) => entry.kind === 'path' && entry.path === relativePath);
            if (previous) operations.push({ target, kind: 'path', path: relativePath, ownership: relativePath, desired, beforeHash: previous.beforeHash });
            continue;
          }
          return { ok: false, reason: 'conflict' };
        } catch { operations.push({ target, kind: 'path', path: relativePath, ownership: relativePath, desired, beforeHash: null }); }
      }
    }
    if (operations.length) return { ok: true, operations };
    return (await loadState(root, target)) ? { ok: true, operations: [] } : { ok: false, reason: 'invalid-config' };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function applyInstall(plan) {
  if (!plan.ok) return plan;
  if (plan.operations.length === 0) return { ok: true };
  for (const operation of plan.operations) {
    if (operation.kind === 'path') continue;
    const current = await readJson(join(plan.root, operation.path));
    if (operation.kind === 'json-array') {
      const [owner, key] = operation.ownership.split('.');
      const existing = current[owner]?.[key] ?? [];
      if (!operation.desired.every((entry) => existing.some((present) => sameJson(present, entry))) && hashText(JSON.stringify(existing)) !== operation.beforeHash) return { ok: false, reason: 'conflict' };
      continue;
    }
    const existingHash = Object.hasOwn(current, operation.ownership) ? hashText(JSON.stringify(current[operation.ownership])) : null;
    if (existingHash !== operation.beforeHash && JSON.stringify(current[operation.ownership]) !== JSON.stringify(operation.desired)) return { ok: false, reason: 'conflict' };
  }
  const applied = [];
  try {
    for (const operation of plan.operations) {
      const path = join(plan.root, operation.path);
      if (operation.kind === 'path') {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, operation.desired);
        applied.push(operation);
        continue;
      }
      const current = await readJson(path);
      if (operation.kind === 'json-array') {
        const [owner, key] = operation.ownership.split('.');
        current[owner] ??= {};
        current[owner][key] ??= [];
        for (const entry of operation.desired) if (!current[owner][key].some((present) => sameJson(present, entry))) current[owner][key].push(entry);
      } else current[operation.ownership] = operation.desired;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
      applied.push(operation);
    }
    for (const operation of plan.operations) {
      await saveState(plan.root, operation.target, { schemaVersion: 1, operations: plan.operations.map((entry) => ({ kind: entry.kind, path: entry.path, ownership: entry.ownership, beforeHash: entry.beforeHash, beforeExists: entry.beforeExists, afterHash: entry.kind === 'path' ? hashText(entry.desired) : hashText(JSON.stringify(entry.desired)), entryHashes: entry.kind === 'json-array' ? entry.desired.map((value) => hashText(JSON.stringify(value))) : undefined })) });
    }
    return { ok: true };
  } catch {
    const residual = [];
    for (const operation of applied.reverse()) {
      const path = join(plan.root, operation.path);
      if (operation.kind === 'path') continue;
      const current = await readJson(path);
      if (Object.hasOwn(current, operation.ownership) && hashText(JSON.stringify(current[operation.ownership])) === hashText(JSON.stringify(operation.desired))) {
        delete current[operation.ownership];
        await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
      } else residual.push({ path: operation.path, ownership: operation.ownership });
    }
    return { ok: false, reason: 'invalid-config', residual };
  }
}

export async function restoreInstall({ root, target }) {
  const state = await loadState(root, target);
  if (!state?.operations) return { ok: false, reason: 'invalid-config' };
  for (const operation of state.operations) {
    if (operation.kind === 'path') {
      try {
        if (hashText(await readFile(join(root, operation.path), 'utf8')) !== operation.afterHash) return { ok: false, reason: 'conflict' };
      } catch { return { ok: false, reason: 'conflict' }; }
      continue;
    }
    const current = await readJson(join(root, operation.path));
    const [owner, key] = operation.ownership.split('.');
    const owned = operation.kind === 'json-array' ? current[owner]?.[key] : current[operation.ownership];
    if (!owned || (operation.kind === 'json-array' ? !operation.entryHashes?.every((entryHash) => owned.some((entry) => hashText(JSON.stringify(entry)) === entryHash)) : hashText(JSON.stringify(owned)) !== operation.afterHash)) return { ok: false, reason: 'conflict' };
  }
  for (const operation of state.operations) {
    const path = join(root, operation.path);
    if (operation.kind === 'path') { await rm(path, { force: true }); continue; }
    const current = await readJson(path);
    if (operation.kind === 'json-array') {
      const [owner, key] = operation.ownership.split('.');
      current[owner][key] = current[owner][key].filter((entry) => !operation.entryHashes.includes(hashText(JSON.stringify(entry))));
      if (operation.beforeExists === false && Object.keys(current).length === 1 && Object.keys(current[owner] ?? {}).length === 1 && Array.isArray(current[owner][key]) && current[owner][key].length === 0) { await rm(path, { force: true }); continue; }
    }
    else delete current[operation.ownership];
    await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  }
  return { ok: true };
}
