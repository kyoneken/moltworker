const REASONS = new Set(['ok', 'missing-command', 'missing-tool', 'invalid-config', 'conflict', 'source-mismatch', 'authentication-failed', 'permission-denied', 'incompatible', 'user-action-required', 'live-check-not-run']);

export function classifyCapability({ toolPresent = false, httpStatus, completed = false } = {}) {
  if (!toolPresent) return 'missing-tool';
  if (httpStatus === 401) return 'authentication-failed';
  if (httpStatus === 403) return 'permission-denied';
  if (completed === true) return 'ok';
  return 'live-check-not-run';
}

export function doctorChecks({ target, commands = {} } = {}) {
  const checks = [];
  const command = commands[target];
  checks.push({ target, component: 'config', status: command ? 'pass' : 'not-verified', reason: command ? 'ok' : 'live-check-not-run', nextAction: command ? 'none' : 'run the selected client configuration check' });
  for (const component of ['github-issues', 'github-projects']) checks.push({ target, component, status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the corresponding GitHub MCP read check from the connected agent' });
  return checks;
}

export function summarizeDoctor({ target, commands } = {}) {
  const checks = doctorChecks({ target, commands });
  for (const check of checks) if (!REASONS.has(check.reason)) throw new Error('invalid result reason');
  return { schemaVersion: 1, checks, ok: !checks.some((check) => check.status === 'fail') };
}
