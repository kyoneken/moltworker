const REASONS = new Set([
  'ok', 'missing-command', 'missing-tool', 'invalid-config', 'conflict',
  'source-mismatch', 'authentication-failed', 'permission-denied',
  'incompatible', 'user-action-required', 'live-check-not-run',
]);

export function result(target, component, status, reason, nextAction) {
  if (!REASONS.has(reason)) throw new Error('invalid result reason');
  return { target, component, status, reason, nextAction };
}

export function summarizeChecks(checks) {
  return { schemaVersion: 1, checks, ok: !checks.some((check) => check.status === 'fail') };
}
