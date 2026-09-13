import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCapability, summarizeDoctor } from '../../scripts/harness/doctor.mjs';
import { result } from '../../scripts/harness/report.mjs';

test('classifies tool, auth, permission and completion independently', () => {
  assert.equal(classifyCapability({ toolPresent: false }), 'missing-tool');
  assert.equal(classifyCapability({ toolPresent: true, httpStatus: 401 }), 'authentication-failed');
  assert.equal(classifyCapability({ toolPresent: true, httpStatus: 403 }), 'permission-denied');
  assert.equal(classifyCapability({ toolPresent: true, completed: true }), 'ok');
  assert.equal(classifyCapability({ toolPresent: true }), 'live-check-not-run');
});

test('static doctor keeps installation, live capabilities, and integrations separate', () => {
  const report = summarizeDoctor({ target: 'codex', install: { ok: true } });
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.checks.map((check) => check.component), ['config', 'client', 'hooks', 'github-issues', 'github-projects', 'onepassword', 'cloudflare-docs', 'cloudflare-observability']);
  assert.equal(report.checks[0].status, 'pass');
  for (const check of report.checks.slice(1)) assert.equal(check.reason, 'live-check-not-run');
});

test('doctor reports unsupported integrations separately', () => {
  const report = summarizeDoctor({ target: 'antigravity', install: { ok: true } });
  const onepassword = report.checks.find((check) => check.component === 'onepassword');
  const cloudflare = report.checks.find((check) => check.component === 'cloudflare-docs');
  assert.equal(onepassword.status, 'skipped');
  assert.equal(onepassword.reason, 'incompatible');
  assert.equal(cloudflare.status, 'skipped');
  assert.equal(cloudflare.reason, 'incompatible');
});

test('report rejects unrecognized statuses as well as result reasons', () => {
  assert.throws(() => result('codex', 'config', 'maybe', 'ok', 'none'), /invalid result status/);
});
