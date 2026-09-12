import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TARGETS } from './harness/targets.mjs';
import { result, summarizeChecks } from './harness/report.mjs';
import { verifySource } from './harness/source.mjs';
import { verifyInstalled } from './harness/verify.mjs';
import { adaptCursorHooks } from './harness/cursor.mjs';
import { summarizeDoctor } from './harness/doctor.mjs';

const DEFAULT_SOURCE = '.harness/source/coding-agent-harness';
const COMMAND_OPTIONS = {
  source: new Set(['--target', '--source']),
  verify: new Set(['--target', '--source']),
  doctor: new Set(['--target']),
  adapt: new Set(['--target']),
};
const SETUP_ACTION = 'follow the explicit APM setup steps in docs/harness-setup.md';

function print(checks) { console.log(JSON.stringify(summarizeChecks(checks))); }
function report(target, component, status, reason, nextAction) { print([result(target, component, status, reason, nextAction)]); }
function invalid() { report('unknown', 'config', 'fail', 'invalid-config', 'review harness command arguments'); process.exitCode = 1; }

function parse(argv) {
  const [command, ...args] = argv;
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return null;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || Object.hasOwn(options, name) || !value || value.startsWith('--')) return null;
    options[name] = value;
  }
  if (!TARGETS.includes(options['--target'])) return null;
  return { command, target: options['--target'], source: options['--source'] ?? DEFAULT_SOURCE };
}

async function sourceCheck(root, source) {
  const lock = JSON.parse(await readFile(resolve(root, 'harness/source-lock.json'), 'utf8'));
  return verifySource(resolve(root, source), lock);
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) return invalid();
  const { command, target, source } = parsed;
  const root = process.cwd();
  if (command === 'adapt') {
    if (target !== 'cursor') { report(target, 'config', 'fail', 'incompatible', 'Cursor is the only target requiring the native adapter'); process.exitCode = 1; return; }
    try { await adaptCursorHooks({ root }); report(target, 'hooks', 'pass', 'ok', 'none'); }
    catch (error) { report(target, 'hooks', 'fail', error?.message === 'conflict' ? 'conflict' : 'invalid-config', SETUP_ACTION); process.exitCode = 1; }
    return;
  }
  if (command === 'source') {
    try {
      const sourceResult = await sourceCheck(root, source);
      report(target, 'source', sourceResult.ok ? 'pass' : 'fail', sourceResult.ok ? 'ok' : sourceResult.reason, sourceResult.ok ? 'none' : SETUP_ACTION);
      if (!sourceResult.ok) process.exitCode = 1;
    } catch { report(target, 'source', 'fail', 'invalid-config', SETUP_ACTION); process.exitCode = 1; }
    return;
  }
  if (command === 'verify') {
    try {
      const sourceResult = await sourceCheck(root, source);
      const checks = [result(target, 'source', sourceResult.ok ? 'pass' : 'fail', sourceResult.ok ? 'ok' : sourceResult.reason, sourceResult.ok ? 'none' : SETUP_ACTION)];
      if (sourceResult.ok) {
        const installed = await verifyInstalled({ root, target });
        checks.push(result(target, 'config', installed.ok ? 'pass' : 'fail', installed.ok ? 'ok' : installed.reason, installed.ok ? 'none' : SETUP_ACTION));
      }
      print(checks);
      if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
    } catch { report(target, 'config', 'fail', 'invalid-config', SETUP_ACTION); process.exitCode = 1; }
    return;
  }
  try {
    const install = await verifyInstalled({ root, target });
    const doctor = summarizeDoctor({ target, install });
    console.log(JSON.stringify(doctor));
    process.exitCode = doctor.ok ? 0 : 1;
  } catch { report(target, 'config', 'fail', 'invalid-config', SETUP_ACTION); process.exitCode = 1; }
}

main().catch(invalid);
