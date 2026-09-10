export const TARGETS = ['codex', 'claude', 'cursor', 'grok-build', 'antigravity'];

export const TARGET_CAPABILITIES = Object.freeze({
  codex: { instructions: 'AGENTS.md', skills: '.agents/skills', hooks: '.codex/hooks.json', mcp: 'stdio+remote' },
  claude: { instructions: '.claude/rules', skills: '.claude/skills', hooks: '.claude/settings.json', mcp: 'stdio+remote' },
  cursor: { instructions: '.cursor/rules', skills: '.agents/skills', hooks: '.cursor/hooks.json', mcp: 'stdio+remote' },
  'grok-build': { instructions: '.grok/rules', skills: '.grok/skills', hooks: 'unsupported', mcp: 'stdio+remote' },
  antigravity: { instructions: '.agents/rules', skills: '.agents/skills', hooks: '.agents/hooks.json', mcp: 'stdio+remote' },
});

export function targetPlan({ target } = {}) {
  if (!TARGETS.includes(target)) return { target, status: 'fail', reason: 'invalid-config', capabilities: null };
  const capabilities = TARGET_CAPABILITIES[target];
  return { target, status: 'pass', reason: 'ok', capabilities, onepassword: target === 'antigravity' ? 'incompatible' : 'command-only', workflow: 'skills/harness-workflow' };
}
