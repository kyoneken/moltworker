import { onepasswordPlan } from './onepassword.mjs';
import { cloudflarePlan } from './cloudflare.mjs';

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
      ? { status: 'fail', reason: install.reason, nextAction: install.reason === 'missing-command' ? 'install Python 3.11+ with tomllib on PATH or set HARNESS_PYTHON_COMMAND to its executable' : 'restore the recorded harness state or bootstrap again after reviewing changes' }
      : { status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the static installed-state check' };
  checks.push({ target, component: 'config', ...installCheck });
  checks.push({ target, component: 'client', status: 'not-verified', reason: 'live-check-not-run', nextAction: 'launch the selected client and confirm it loads the project configuration' });
  checks.push({ target, component: 'hooks', status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the target hook handshake from the client' });
  for (const component of ['github-issues', 'github-projects']) checks.push({ target, component, status: 'not-verified', reason: 'live-check-not-run', nextAction: 'run the corresponding GitHub MCP read check from the connected agent' });
  const onepassword = onepasswordPlan({ target });
  checks.push({ target, component: 'onepassword', status: onepassword.status === 'pass' ? 'not-verified' : onepassword.status, reason: onepassword.status === 'pass' ? 'live-check-not-run' : onepassword.reason, nextAction: onepassword.status === 'pass' ? 'run the client check and approve Desktop access' : onepassword.nextAction });
  const cloudflare = cloudflarePlan({ target });
  const cloudflareStatus = cloudflare.status === 'pass' ? 'not-verified' : cloudflare.status;
  const cloudflareReason = cloudflare.status === 'pass' ? 'live-check-not-run' : cloudflare.reason;
  checks.push({ target, component: 'cloudflare-docs', status: cloudflareStatus, reason: cloudflareReason, nextAction: cloudflare.status === 'pass' ? 'run a read-only Docs MCP handshake from the client' : 'review the Cloudflare Docs MCP configuration' });
  checks.push({ target, component: 'cloudflare-observability', status: cloudflareStatus, reason: cloudflareReason, nextAction: cloudflare.status === 'pass' ? 'authenticate and run a read-only Observability MCP handshake from the client' : 'review the Cloudflare Observability MCP configuration' });
  return checks;
}

export function summarizeDoctor({ target, install } = {}) {
  const checks = doctorChecks({ target, install });
  for (const check of checks) if (!REASONS.has(check.reason) || !['pass', 'fail', 'not-verified', 'skipped'].includes(check.status)) throw new Error('invalid result');
  return { schemaVersion: 1, checks, ok: !checks.some((check) => check.status === 'fail') };
}
