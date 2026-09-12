import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyInstall, planInstall, restoreInstall, TARGETS, verifyInstall } from './harness/install.mjs';
import { result, summarizeChecks } from './harness/report.mjs';
import { verifySource } from './harness/source.mjs';
import { summarizeDoctor } from './harness/doctor.mjs';

const DEFAULT_SOURCE = '.harness/source/coding-agent-harness';
const COMMAND_OPTIONS = {
  bootstrap: new Set(['--target', '--source', '--profile']),
  restore: new Set(['--target']),
  verify: new Set(['--target', '--source']),
  doctor: new Set(['--target']),
};

const sourceAction = 'populate .harness/source/coding-agent-harness with the exact files in harness/source-lock.json via GitHub MCP, or use --source with a verified cache; see docs/harness-setup.md';
const nextAction = (reason) => reason === 'ok' ? 'none' : reason === 'source-mismatch' ? sourceAction : reason === 'missing-command' ? 'install Python 3.11+ with tomllib on PATH or set HARNESS_PYTHON_COMMAND to its executable' : 'review harness configuration';

function outputChecks(checks) { console.log(JSON.stringify(summarizeChecks(checks))); }
function output(target, component, status, reason) { outputChecks([result(target, component, status, reason, nextAction(reason))]); }
function invalid(target = 'unknown') { output(target, 'config', 'fail', 'invalid-config'); process.exitCode = 1; }

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
  if (!options['--target'] || !TARGETS.includes(options['--target'])) return null;
  if (command === 'bootstrap' && options['--profile'] && !['base', 'observability'].includes(options['--profile'])) return null;
  return { command, target: options['--target'], source: options['--source'] ?? DEFAULT_SOURCE, profile: options['--profile'] ?? 'base' };
}

async function loadSource(root, source) {
  const lock = JSON.parse(await readFile(resolve(root, 'harness/source-lock.json'), 'utf8'));
  const sourceDir = resolve(root, source);
  return { sourceDir, verified: await verifySource(sourceDir, lock) };
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) return invalid();
  const { command, target, source, profile } = parsed;
  const root = process.cwd();
  if (command === 'bootstrap') {
    try {
      const { sourceDir, verified } = await loadSource(root, source);
      if (!verified.ok) { output(target, 'source', 'fail', verified.reason); process.exitCode = 1; return; }
      const planned = await planInstall({ root, target, sourceDir, profile });
      if (planned.ok) planned.root = root;
      const applied = await applyInstall(planned);
      output(target, 'config', applied.ok ? 'pass' : 'fail', applied.ok ? 'ok' : applied.reason);
      if (!applied.ok) process.exitCode = 1;
    } catch { invalid(target); }
    return;
  }
  if (command === 'restore') {
    try {
      const restored = await restoreInstall({ root, target });
      output(target, 'config', restored.ok ? 'pass' : 'fail', restored.ok ? 'ok' : restored.reason);
      if (!restored.ok) process.exitCode = 1;
    } catch { invalid(target); }
    return;
  }
  if (command === 'verify') {
    try {
      const { verified } = await loadSource(root, source);
      const checks = [result(target, 'source', verified.ok ? 'pass' : 'fail', verified.ok ? 'ok' : verified.reason, verified.ok ? 'none' : sourceAction)];
      if (verified.ok) {
        const installed = await verifyInstall({ root, target });
        checks.push(result(target, 'config', installed.ok ? 'pass' : 'fail', installed.ok ? 'ok' : installed.reason, installed.ok ? 'none' : installed.reason === 'missing-command' ? nextAction(installed.reason) : 'restore the recorded state or bootstrap again after reviewing changes'));
      }
      outputChecks(checks);
      if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
    } catch { invalid(target); }
    return;
  }
  try {
    const install = await verifyInstall({ root, target });
    const report = summarizeDoctor({ target, install });
    console.log(JSON.stringify(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch { invalid(target); }
}

main().catch(() => invalid());
