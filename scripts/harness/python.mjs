import { spawnSync } from 'node:child_process';

// Probe capability, not a particular versioned executable name. Never forward
// interpreter errors: parsing failures can contain fragments of private input.
export function findPython({ execute = spawnSync, env = process.env } = {}) {
  const candidates = env.HARNESS_PYTHON_COMMAND
    ? [env.HARNESS_PYTHON_COMMAND]
    : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python'];
  for (const command of candidates) {
    const result = execute(command, ['-c', 'import sys,tomllib; sys.exit(0 if sys.version_info >= (3,11) else 1)'], {
      encoding: 'utf8', stdio: 'ignore', timeout: 5000,
    });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error('missing-command');
}

export function runPython(script, input) {
  return spawnSync(findPython(), ['-c', script], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}
