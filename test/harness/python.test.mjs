import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPython, runPython } from '../../scripts/harness/python.mjs';

test('uses python3 with tomllib when python3.11 is unavailable', () => {
  const calls = [];
  const execute = (command) => { calls.push(command); return command === 'python3' ? { status: 0 } : { status: null }; };
  assert.equal(findPython({ execute, env: {} }), 'python3');
  assert.ok(calls.includes('python3'));
});

test('rejects old Python and reports a missing dependency separately', () => {
  assert.throws(() => findPython({ execute: () => ({ status: 1 }), env: {} }), /missing-command/);
});

test('explicit Python override is tested and is not silently replaced', () => {
  const calls = [];
  assert.throws(() => findPython({ execute: (command) => { calls.push(command); return { status: 1 }; }, env: { HARNESS_PYTHON_COMMAND: '/missing/python' } }), /missing-command/);
  assert.deepEqual(calls, ['/missing/python']);
});

test('real Python can parse TOML without returning source contents', () => {
  const result = runPython('import sys,tomllib; tomllib.loads(sys.stdin.read())', '[example]\nvalue = true\n');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
