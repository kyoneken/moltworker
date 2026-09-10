import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyInstall, planInstall, restoreInstall, TARGETS } from './harness/install.mjs';
import { result, summarizeChecks } from './harness/report.mjs';
import { verifySource } from './harness/source.mjs';
import { summarizeDoctor } from './harness/doctor.mjs';

function argument(name) { const index = process.argv.indexOf(name); return index === -1 ? null : process.argv[index + 1] || null; }
function output(target, component, status, reason) { console.log(JSON.stringify(summarizeChecks([result(target, component, status, reason, reason === 'ok' ? 'none' : 'review harness configuration')]))); }

const [command] = process.argv.slice(2);
const target = argument('--target');
const root = process.cwd();
if (!target || !TARGETS.includes(target)) { output(target ?? 'unknown', 'config', 'fail', 'invalid-config'); process.exitCode = 1; }
else if (command === 'bootstrap') {
  const source = argument('--source');
  try {
    const lock = JSON.parse(await readFile(resolve(root, 'harness/source-lock.json'), 'utf8'));
    const verified = await verifySource(source, lock);
    if (!verified.ok) { output(target, 'source', 'fail', verified.reason); process.exitCode = 1; }
    else {
      const planned = await planInstall({ root, target, sourceDir: source, profile: argument('--profile') ?? 'base' });
      if (planned.ok) planned.root = root;
      const applied = await applyInstall(planned);
      output(target, 'config', applied.ok ? 'pass' : 'fail', applied.ok ? 'ok' : applied.reason);
      if (!applied.ok) process.exitCode = 1;
    }
  } catch { output(target, 'source', 'fail', 'invalid-config'); process.exitCode = 1; }
} else if (command === 'restore') {
  const restored = await restoreInstall({ root, target });
  output(target, 'config', restored.ok ? 'pass' : 'fail', restored.ok ? 'ok' : restored.reason);
  if (!restored.ok) process.exitCode = 1;
} else if (command === 'verify') {
  try {
    const source = argument('--source') ?? '.harness/source/coding-agent-harness';
    const lock = JSON.parse(await readFile(resolve(root, 'harness/source-lock.json'), 'utf8'));
    const verified = await verifySource(resolve(root, source), lock);
    output(target, 'source', verified.ok ? 'pass' : 'fail', verified.ok ? 'ok' : verified.reason);
    if (!verified.ok) process.exitCode = 1;
  } catch { output(target, 'source', 'fail', 'invalid-config'); process.exitCode = 1; }
} else if (command === 'doctor') {
  const report = summarizeDoctor({ target, commands: {} });
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
} else {
  output(target, 'config', 'fail', 'invalid-config'); process.exitCode = 1;
}
