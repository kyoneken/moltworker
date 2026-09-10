import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctorOnepassword, onepasswordPlan } from '../../scripts/harness/onepassword.mjs';

test('supported targets receive command-only 1Password configuration', () => {
  for (const target of ['codex', 'claude', 'cursor', 'grok-build']) {
    const plan = onepasswordPlan({ target });
    assert.equal(plan.server.command, '1password-mcp');
    assert.deepEqual(plan.server.args, []);
    assert.deepEqual(plan.server.env, {});
  }
});

test('Antigravity is explicitly incompatible and static checks stay unverified', () => {
  assert.equal(onepasswordPlan({ target: 'antigravity' }).reason, 'incompatible');
  assert.equal(doctorOnepassword({ target: 'codex' }).reason, 'live-check-not-run');
});
