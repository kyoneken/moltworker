const REASONS = new Set([
  'ok', 'missing-command', 'missing-tool', 'invalid-config', 'conflict',
  'source-mismatch', 'authentication-failed', 'permission-denied',
  'incompatible', 'user-action-required', 'live-check-not-run',
]);
const STATUSES = new Set(['pass', 'fail', 'not-verified', 'skipped']);

export function result(target, component, status, reason, nextAction) {
  if (!STATUSES.has(status)) throw new Error('invalid result status');
  if (!REASONS.has(reason)) throw new Error('invalid result reason');
  return { target, component, status, reason, nextAction };
}

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || checks.some((check) => !STATUSES.has(check.status) || !REASONS.has(check.reason))) throw new Error('invalid report checks');
  return { schemaVersion: 1, checks, ok: !checks.some((check) => check.status === 'fail') };
}
