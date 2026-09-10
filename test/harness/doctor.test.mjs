import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCapability, summarizeDoctor } from '../../scripts/harness/doctor.mjs';

test('classifies tool, auth, permission and completion independently', () => {
  assert.equal(classifyCapability({ toolPresent: false }), 'missing-tool');
  assert.equal(classifyCapability({ toolPresent: true, httpStatus: 401 }), 'authentication-failed');
  assert.equal(classifyCapability({ toolPresent: true, httpStatus: 403 }), 'permission-denied');
  assert.equal(classifyCapability({ toolPresent: true, completed: true }), 'ok');
  assert.equal(classifyCapability({ toolPresent: true }), 'live-check-not-run');
});

test('static doctor keeps GitHub issue and project checks separate', () => {
  const report = summarizeDoctor({ target: 'codex', commands: { codex: true } });
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.checks.map((check) => check.component), ['config', 'github-issues', 'github-projects']);
  assert.equal(report.checks[0].status, 'pass');
  assert.equal(report.checks[1].reason, 'live-check-not-run');
  assert.equal(report.checks[2].reason, 'live-check-not-run');
});
