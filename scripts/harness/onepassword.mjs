const SUPPORTED = new Set(['codex', 'claude', 'cursor', 'grok-build']);

export function onepasswordPlan({ target } = {}) {
  if (target === 'antigravity') return { target, status: 'skipped', reason: 'incompatible', nextAction: 'use a supported client for 1Password MCP' };
  if (!SUPPORTED.has(target)) return { target, status: 'fail', reason: 'invalid-config', nextAction: 'select one supported target' };
  return { target, status: 'pass', reason: 'ok', nextAction: 'approve 1Password Desktop when prompted', server: { command: '1password-mcp', args: [], env: {} } };
}

export function doctorOnepassword({ target, commands = {} } = {}) {
  const plan = onepasswordPlan({ target });
  if (plan.status !== 'pass') return plan;
  return { target, status: commands[target] ? 'pass' : 'not-verified', reason: commands[target] ? 'ok' : 'live-check-not-run', nextAction: commands[target] ? 'none' : 'run the client check and approve Desktop access', server: plan.server };
}
