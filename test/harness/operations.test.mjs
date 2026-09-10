import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOperations, restoreOperations } from '../../scripts/harness/operations.mjs';

test('JSON pointer operation preserves unrelated keys and restore returns prior owned value', () => {
  const before = { mcpServers: { existing: { command: 'keep' } }, policy: true };
  const operation = { kind: 'json-key', path: 'x.json', pointer: '/mcpServers/harness', desired: { command: 'safe' } };
  const applied = applyOperations([{ path: 'x.json', text: JSON.stringify(before) }], [operation]);
  assert.deepEqual(JSON.parse(applied.files[0].text), { mcpServers: { existing: { command: 'keep' }, harness: { command: 'safe' } }, policy: true });
  const restored = restoreOperations(applied.files, applied.state);
  assert.deepEqual(JSON.parse(restored.files[0].text), before);
});

test('array ownership rejects identical unmanaged entries and preserves adjacent entries on restore', () => {
  const operation = { kind: 'json-array', path: 'x.json', pointer: '/hooks/PreToolUse', desired: [{ command: 'owned' }] };
  assert.throws(() => applyOperations([{ path: 'x.json', text: JSON.stringify({ hooks: { PreToolUse: [{ command: 'owned' }] } }) }], [operation]), /conflict/);
  const applied = applyOperations([{ path: 'x.json', text: JSON.stringify({ hooks: { PreToolUse: [{ command: 'keep' }] } }) }], [operation]);
  const restored = restoreOperations([{ path: 'x.json', text: JSON.stringify({ hooks: { PreToolUse: [{ command: 'keep' }, { command: 'owned' }, { command: 'new' }] } }) }], applied.state);
  assert.deepEqual(JSON.parse(restored.files[0].text).hooks.PreToolUse, [{ command: 'keep' }, { command: 'new' }]);
});

test('markdown block is bounded and toml block is syntax validated before writes', () => {
  const markdown = { kind: 'markdown-block', path: 'AGENTS.md', marker: 'harness', desired: 'reference' };
  const applied = applyOperations([{ path: 'AGENTS.md', text: '# Keep\n' }], [markdown]);
  assert.match(applied.files[0].text, /# Keep/);
  assert.throws(() => applyOperations([{ path: 'a.toml', text: 'bad = [' }], [{ kind: 'toml-block', path: 'a.toml', marker: 'harness', desired: 'x = 1' }]), /invalid-config/);
});

test('toml returned text is valid TOML and array restore rejects duplicate owned entries', () => {
  const toml = applyOperations([{ path: 'a.toml', text: 'outside = 1\n' }], [{ kind: 'toml-block', path: 'a.toml', marker: 'h', desired: 'inside = 2' }]);
  assert.doesNotMatch(toml.files[0].text, /<!--/);
  const applied = applyOperations([{ path: 'x.json', text: JSON.stringify({ hooks: { PreToolUse: [] } }) }], [{ kind: 'json-array', path: 'x.json', pointer: '/hooks/PreToolUse', desired: [{ command: 'owned' }] }]);
  assert.throws(() => restoreOperations([{ path: 'x.json', text: JSON.stringify({ hooks: { PreToolUse: [{ command: 'owned' }, { command: 'owned' }] } }) }], applied.state), /conflict/);
});
