const SUPPORTED = new Set(['codex', 'claude', 'cursor', 'grok-build']);

export function onepasswordPlan({ target, existing = {} } = {}) {
  if (target === 'antigravity') return { target, status: 'skipped', reason: 'incompatible', nextAction: 'use a supported client for 1Password MCP' };
  if (!SUPPORTED.has(target)) return { target, status: 'fail', reason: 'invalid-config', nextAction: 'select one supported target' };
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) return { target, status: 'fail', reason: 'invalid-config', nextAction: 'select one supported target' };
  const current = existing['1password'];
  if (current !== undefined) {
    const commandOnly = current && typeof current === 'object' && !Array.isArray(current)
      && Object.keys(current).every((key) => ['command', 'args', 'env', 'type', 'enabled'].includes(key))
      && (current.enabled === undefined || current.enabled === true)
      && (current.type === undefined || current.type === 'stdio')
      && current.command === '1password-mcp'
      && (current.args === undefined || (Array.isArray(current.args) && current.args.length === 0))
      && (current.env === undefined || (typeof current.env === 'object' && current.env !== null && !Array.isArray(current.env) && Object.keys(current.env).length === 0));
    if (!commandOnly) return { target, status: 'fail', reason: 'conflict', nextAction: 'resolve the existing 1Password MCP configuration' };
    return { target, status: 'pass', reason: 'ok', nextAction: 'approve 1Password Desktop when prompted' };
  }
  return { target, status: 'pass', reason: 'ok', nextAction: 'approve 1Password Desktop when prompted', server: { command: '1password-mcp', args: [], env: {} } };
}

export function doctorOnepassword({ target, commands = {} } = {}) {
  const plan = onepasswordPlan({ target });
  if (plan.status !== 'pass') return plan;
  return { target, status: commands[target] ? 'pass' : 'not-verified', reason: commands[target] ? 'ok' : 'live-check-not-run', nextAction: commands[target] ? 'none' : 'run the client check and approve Desktop access', server: plan.server };
}
