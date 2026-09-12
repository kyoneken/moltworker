const REASONS = new Set(['ok', 'missing-command', 'missing-tool', 'invalid-config', 'conflict', 'source-mismatch', 'authentication-failed', 'permission-denied', 'incompatible', 'user-action-required', 'live-check-not-run']);

export function classifyCapability({ toolPresent = false, httpStatus, completed = false } = {}) {
  if (!toolPresent) return 'missing-tool';
  if (httpStatus === 401) return 'authentication-failed';
  if (httpStatus === 403) return 'permission-denied';
  if (completed === true) return 'ok';
  return 'live-check-not-run';
}

export function doctorChecks({ target, install } = {}) {
  const checks = [];
  const installCheck = install?.ok === true
    ? { status: 'pass', reason: 'ok', nextAction: 'none' }
    : install?.reason
      ? { status: 'fail', reason: install.reason, nextAction: 'follow the explicit APM setup steps in docs/harness-setup.md' }
      : { status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the static installed-state check' };
  checks.push({ target, component: 'config', ...installCheck });
  checks.push({ target, component: 'client', status: 'not-verified', reason: 'live-check-not-run', nextAction: 'launch the selected client and confirm it loads the project configuration' });
  checks.push({ target, component: 'hooks', status: target === 'grok-build' ? 'skipped' : 'not-verified', reason: target === 'grok-build' ? 'incompatible' : 'live-check-not-run', nextAction: target === 'grok-build' ? 'Grok Build has no verified native pre-tool hook target' : 'run the target hook handshake from the client' });
  for (const component of ['github-issues', 'github-projects']) checks.push({ target, component, status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the corresponding GitHub MCP read check from the connected agent' });
  const unsupportedMcp = target === 'antigravity';
  const mcpStatus = unsupportedMcp ? 'skipped' : 'not-verified';
  const mcpReason = unsupportedMcp ? 'incompatible' : 'live-check-not-run';
  checks.push({ target, component: 'onepassword', status: mcpStatus, reason: mcpReason, nextAction: unsupportedMcp ? 'Antigravity has no verified project-local 1Password MCP schema' : 'run the client check and approve Desktop access' });
  checks.push({ target, component: 'cloudflare-docs', status: mcpStatus, reason: mcpReason, nextAction: unsupportedMcp ? 'Antigravity has no verified project-local remote MCP schema' : 'run a read-only Docs MCP handshake from the client' });
  checks.push({ target, component: 'cloudflare-observability', status: mcpStatus, reason: mcpReason, nextAction: unsupportedMcp ? 'Antigravity has no verified project-local remote MCP schema' : 'authenticate and run a read-only Observability MCP handshake from the client' });
  return checks;
}

export function summarizeDoctor({ target, install } = {}) {
  const checks = doctorChecks({ target, install });
  for (const check of checks) if (!REASONS.has(check.reason) || !['pass', 'fail', 'not-verified', 'skipped'].includes(check.status)) throw new Error('invalid result');
  return { schemaVersion: 1, checks, ok: !checks.some((check) => check.status === 'fail') };
}
