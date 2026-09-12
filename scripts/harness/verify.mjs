import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPython } from './python.mjs';

const TARGETS = new Set(['codex', 'claude', 'cursor', 'grok-build', 'antigravity']);
const DOCS_URL = 'https://docs.mcp.cloudflare.com/mcp';
const skillDirectory = {
  codex: '.agents/skills', claude: '.claude/skills', cursor: '.agents/skills',
  'grok-build': '.grok/skills', antigravity: '.agents/skills',
};
const hookFile = {
  codex: '.codex/hooks.json', claude: '.claude/settings.json', cursor: '.cursor/hooks.json', antigravity: '.agents/hooks.json',
};
const mcpFile = {
  codex: '.codex/config.toml', claude: '.mcp.json', cursor: '.cursor/mcp.json', 'grok-build': '.grok/config.toml',
};

async function text(root, path) {
  try {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid-config');
    return await readFile(join(root, path), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function requiredFile(root, path) {
  const contents = await text(root, path);
  if (contents === null) throw new Error('missing-tool');
  return contents;
}

function parseJson(contents) {
  try {
    const value = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('invalid-config'); }
}

function parseToml(contents) {
  let result;
  try { result = runPython('import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))', contents); }
  catch (error) { throw new Error(error?.message === 'missing-command' ? 'missing-tool' : 'invalid-config'); }
  if (result.status !== 0) throw new Error('invalid-config');
  return parseJson(result.stdout);
}

function validateLocalServer(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server) || server.command !== '1password-mcp') throw new Error('invalid-config');
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length !== 0)) throw new Error('invalid-config');
  if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env) || Object.keys(server.env).length !== 0)) throw new Error('invalid-config');
}

function validateDocsServer(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server) || server.url !== DOCS_URL) throw new Error('invalid-config');
  if (server.args !== undefined || server.env !== undefined || server.command !== undefined) throw new Error('invalid-config');
  if (Object.keys(server).some((key) => /auth|header|secret|token|credential|env/i.test(key))) throw new Error('invalid-config');
}

async function verifySkills(root, target) {
  const directory = skillDirectory[target];
  for (const skill of ['onepassword-environments', 'subagent-driven-implementation']) {
    const contents = await requiredFile(root, `${directory}/${skill}/SKILL.md`);
    if (contents.trim().length === 0) throw new Error('invalid-config');
  }
}

async function verifyHooks(root, target) {
  const path = hookFile[target];
  if (!path) return;
  const config = parseJson(await requiredFile(root, path));
  const entries = target === 'antigravity'
    ? config.apm?.PreToolUse
    : target === 'cursor' ? config.hooks?.preToolUse : config.hooks?.PreToolUse;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('invalid-config');
  if (target === 'cursor' && !entries.some((entry) => entry?.matcher === 'Shell' && entry.command === 'node scripts/harness/cursor-adapter.mjs')) throw new Error('invalid-config');
}

async function verifyMcp(root, target) {
  if (target === 'antigravity') return;
  const contents = await requiredFile(root, mcpFile[target]);
  const config = target === 'codex' || target === 'grok-build' ? parseToml(contents) : parseJson(contents);
  const servers = config.mcp_servers ?? config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('invalid-config');
  validateLocalServer(servers['1password']);
  validateDocsServer(servers['cloudflare-docs']);
}

export async function verifyInstalled({ root, target } = {}) {
  if (!TARGETS.has(target) || typeof root !== 'string' || root.length === 0) return { ok: false, reason: 'invalid-config' };
  try {
    await verifySkills(root, target);
    await verifyHooks(root, target);
    await verifyMcp(root, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message === 'missing-tool' ? 'missing-tool' : 'invalid-config' };
  }
}

export { DOCS_URL };
