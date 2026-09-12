import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { makeRoot, removeRoot, write } from './helpers.mjs';
import { verifyInstalled } from '../../scripts/harness/verify.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeRoot)));

async function fixture(target = 'codex') {
  const root = await makeRoot();
  roots.push(root);
  const skills = { codex: '.agents/skills', claude: '.claude/skills', cursor: '.agents/skills', 'grok-build': '.grok/skills', antigravity: '.agents/skills' }[target];
  for (const skill of ['onepassword-environments', 'subagent-driven-implementation']) await write(root, `${skills}/${skill}/SKILL.md`, '# skill\n');
  const hooks = { codex: ['.codex/hooks.json', { hooks: { PreToolUse: [{}] } }], claude: ['.claude/settings.json', { hooks: { PreToolUse: [{}] } }], cursor: ['.cursor/hooks.json', { version: 1, hooks: { preToolUse: [{ matcher: 'Shell', command: 'node scripts/harness/cursor-adapter.mjs' }], beforeMCPExecution: [{ command: 'node scripts/harness/cursor-adapter.mjs', failClosed: true }] } }], antigravity: ['.agents/hooks.json', { apm: { PreToolUse: [{}] } }] }[target];
  if (hooks) await write(root, hooks[0], JSON.stringify(hooks[1]));
  if (target === 'codex' || target === 'grok-build') await write(root, target === 'codex' ? '.codex/config.toml' : '.grok/config.toml', '[mcp_servers."1password"]\ncommand = "1password-mcp"\nargs = []\n\n[mcp_servers."cloudflare-docs"]\nurl = "https://docs.mcp.cloudflare.com/mcp"\n');
  if (target === 'claude' || target === 'cursor') await write(root, target === 'claude' ? '.mcp.json' : '.cursor/mcp.json', JSON.stringify({ mcpServers: { '1password': { command: '1password-mcp', args: [] }, 'cloudflare-docs': { url: 'https://docs.mcp.cloudflare.com/mcp' } } }));
  return root;
}

test('verifies native files, the two APM skills, and safe Codex MCP entries', async () => {
  const root = await fixture();
  assert.deepEqual(await verifyInstalled({ root, target: 'codex' }), { ok: true });
});

test('checks supported JSON and TOML target schemas and skips Antigravity MCP', async () => {
  for (const target of ['claude', 'cursor', 'grok-build', 'antigravity']) {
    const root = await fixture(target);
    assert.deepEqual(await verifyInstalled({ root, target }), { ok: true }, target);
  }
});

test('rejects secret-bearing 1Password server settings', async () => {
  const root = await fixture();
  await write(root, '.codex/config.toml', '[mcp_servers."1password"]\ncommand = "1password-mcp"\nenv = { TOKEN = "secret-value" }\n\n[mcp_servers."cloudflare-docs"]\nurl = "https://docs.mcp.cloudflare.com/mcp"\n');
  assert.deepEqual(await verifyInstalled({ root, target: 'codex' }), { ok: false, reason: 'invalid-config' });
});

test('rejects secret-bearing Cloudflare Docs settings', async () => {
  const root = await fixture();
  await write(root, '.codex/config.toml', '[mcp_servers."1password"]\ncommand = "1password-mcp"\n\n[mcp_servers."cloudflare-docs"]\nurl = "https://docs.mcp.cloudflare.com/mcp"\nheaders = { Authorization = "secret-value" }\n');
  assert.deepEqual(await verifyInstalled({ root, target: 'codex' }), { ok: false, reason: 'invalid-config' });
});

test('reports a missing required skill separately from malformed configuration', async () => {
  const root = await fixture();
  await import('node:fs/promises').then(({ rm }) => rm(`${root}/.agents/skills/onepassword-environments/SKILL.md`));
  assert.deepEqual(await verifyInstalled({ root, target: 'codex' }), { ok: false, reason: 'missing-tool' });
  const malformed = await fixture('cursor');
  await write(malformed, '.cursor/mcp.json', '{broken');
  assert.deepEqual(await verifyInstalled({ root: malformed, target: 'cursor' }), { ok: false, reason: 'invalid-config' });
});
