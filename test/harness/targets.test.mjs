import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TARGETS, targetPlan } from '../../scripts/harness/targets.mjs';

test('each target has an explicit capability mapping', () => {
  assert.deepEqual(TARGETS, ['codex', 'claude', 'cursor', 'grok-build', 'antigravity']);
  for (const target of TARGETS) {
    const plan = targetPlan({ target });
    assert.equal(plan.status, 'pass');
    assert.ok(plan.capabilities.instructions);
    assert.ok(plan.capabilities.skills);
    assert.ok(plan.capabilities.mcp);
  }
});

test('Grok and Antigravity limitations remain explicit', () => {
  assert.equal(targetPlan({ target: 'grok-build' }).capabilities.hooks, 'unsupported');
  assert.equal(targetPlan({ target: 'antigravity' }).onepassword, 'incompatible');
  assert.equal(targetPlan({ target: 'unknown' }).reason, 'invalid-config');
});
