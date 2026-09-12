const CURSOR_ADAPTER_PATH = '.harness/generated/cursor-github-policy.mjs';
const cursorCommand = (guard) => `/usr/bin/env node ${CURSOR_ADAPTER_PATH}${guard ? ` --secret-guard ${JSON.stringify(guard)}` : ''}`;
const CLAUDE_COMMAND = '/usr/bin/env node "${CLAUDE_PROJECT_DIR}/.codex/hooks/github-policy.mjs"';

const cursorAdapter = `import { spawnSync } from 'node:child_process';
import { evaluateEvent } from '../../.codex/hooks/github-policy.mjs';

const deny = (reason) => ({ permission: 'deny', user_message: reason });
const allow = () => ({ permission: 'allow' });

function resultFor(event) {
  if (event?.tool_name === 'Shell') {
    const guardIndex = process.argv.indexOf('--secret-guard');
    const guard = guardIndex >= 0 ? process.argv[guardIndex + 1] : undefined;
    if (guard) {
      const guarded = spawnSync('/bin/sh', [guard], { input: JSON.stringify({ command: event.tool_input?.command }), encoding: 'utf8', timeout: 5_000 });
      if (guarded.status !== 0) return deny('Blocked by secret safety policy');
    }
    const result = evaluateEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: event.tool_input?.command } });
    return result.allowed ? allow() : deny(result.reason ?? 'Blocked by repository policy');
  }
  if (event?.mcp_server_name !== 'github') return allow();
  if (typeof event.tool_name !== 'string' || typeof event.tool_input !== 'string') return deny('Malformed GitHub MCP input');
  let toolInput;
  try { toolInput = JSON.parse(event.tool_input); } catch { return deny('Malformed GitHub MCP input'); }
  const result = evaluateEvent({ hook_event_name: 'PreToolUse', tool_name: \`mcp__github__\${event.tool_name}\`, tool_input: toolInput });
  return result.allowed ? allow() : deny(result.reason ?? 'Blocked by repository policy');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (input.length > 65536) return;
  input += chunk.slice(0, 65537 - input.length);
});
process.stdin.on('end', () => {
  try { process.stdout.write(JSON.stringify(input.length > 65536 ? deny('Hook input too large') : resultFor(JSON.parse(input)))); }
  catch { process.stdout.write(JSON.stringify(deny('Malformed hook input'))); }
});
`;

const jsonArray = (path, pointer, desired) => ({ kind: 'json-array', path, pointer, desired });
const jsonKey = (path, pointer, desired) => ({ kind: 'json-key', path, pointer, desired });
const path = (filePath, desired) => ({ kind: 'path', path: filePath, desired });

const SECRET_ADAPTER_PATH = '.harness/generated/native-secret-guard.mjs';
const secretAdapter = `import { spawnSync } from 'node:child_process';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk.slice(0, Math.max(0, 65537 - input.length)); });
process.stdin.on('end', () => {
  if (input.length > 65536) process.exit(2);
  const result = spawnSync('/bin/sh', [process.argv[2]], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (result.status !== 0) { process.stderr.write('Blocked by secret safety policy\\n'); process.exit(2); }
});
`;

function generatedHookOperations(target, generatedFiles) {
  if (generatedFiles === undefined || target === 'cursor' || target === 'grok-build') return [];
  if (!Array.isArray(generatedFiles)) return null;
  const hookFile = target === 'codex' ? '.codex/hooks.json' : target === 'claude' ? '.claude/settings.json' : '.agents/hooks.json';
  const generated = generatedFiles.find((file) => file?.path === hookFile);
  if (!generated) return [];
  if (typeof generated.text !== 'string') return null;
  let config;
  try { config = JSON.parse(generated.text); } catch { return null; }
  const pointer = target === 'antigravity' ? '/apm/PreToolUse' : '/hooks/PreToolUse';
  const entries = target === 'antigravity' ? config.apm?.PreToolUse : config.hooks?.PreToolUse;
  if (!Array.isArray(entries) || entries.length === 0) return [];
  let wrapped = false;
  if (target === 'claude' || target === 'codex') {
    for (const group of entries) for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && /^[./A-Za-z0-9_-]+secret-command-guard\.sh$/.test(hook.command)) {
        hook.command = `/usr/bin/env node ${SECRET_ADAPTER_PATH} ${JSON.stringify(hook.command)}`;
        wrapped = true;
      }
    }
  }
  return [...(wrapped ? [path(SECRET_ADAPTER_PATH, secretAdapter)] : []), jsonArray(hookFile, pointer, entries)];
}

function cursorSecretGuard(generatedFiles) {
  if (!Array.isArray(generatedFiles)) return undefined;
  const file = generatedFiles.find((entry) => entry?.path === '.cursor/hooks.json');
  if (!file || typeof file.text !== 'string') return undefined;
  try {
    const hooks = JSON.parse(file.text).hooks?.PreToolUse;
    for (const group of hooks ?? []) for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.endsWith('secret-command-guard.sh')) return hook.command;
    }
  } catch { return undefined; }
  return undefined;
}

/**
 * Return only native, project-local hook deltas. Provider configuration is
 * deliberately planned by its provider module so unsupported native schemas
 * never result in an invented configuration file.
 */
export function planNativeOperations({ target, generatedFiles, secretSafetyText } = {}) {
  const generated = generatedHookOperations(target, generatedFiles);
  if (generated === null) return { status: 'fail', reason: 'invalid-config', operations: [] };
  if (target === 'claude') {
    const operations = [...generated.filter((operation) => operation.kind === 'path'), jsonArray('.claude/settings.json', '/hooks/PreToolUse', [...generated.filter((operation) => operation.kind === 'json-array').flatMap((operation) => operation.desired), {
      matcher: 'Bash|mcp__github__.*',
      hooks: [{ type: 'command', command: CLAUDE_COMMAND, timeout: 10 }],
    }])];
    return {
      status: 'pass', reason: 'ok', operations,
    };
  }

  if (target === 'cursor') {
    const guard = cursorSecretGuard(generatedFiles);
    const command = cursorCommand(guard);
    const operations = [
      path(CURSOR_ADAPTER_PATH, cursorAdapter),
      jsonKey('.cursor/hooks.json', '/version', 1),
      jsonArray('.cursor/hooks.json', '/hooks/preToolUse', [{ matcher: 'Shell', command, timeout: 10 }]),
      jsonArray('.cursor/hooks.json', '/hooks/beforeMCPExecution', [{ command, timeout: 10, failClosed: true }]),
    ];
    return {
      status: 'pass', reason: 'ok', operations,
    };
  }

  if (target === 'antigravity') {
    return { status: 'pass', reason: 'ok', remoteMcp: { status: 'skipped', reason: 'incompatible' }, operations: generated };
  }

  if (target === 'codex' || target === 'grok-build') {
    if (target === 'codex' && secretSafetyText !== undefined) {
      if (typeof secretSafetyText !== 'string' || secretSafetyText.length === 0) return { status: 'fail', reason: 'invalid-config', operations: [] };
      return {
        status: 'pass', reason: 'ok', operations: [
          ...generated,
          path('.codex/rules/secret-safety.md', secretSafetyText),
          { kind: 'markdown-block', path: 'AGENTS.md', marker: 'harness-codex-secret-safety', desired: 'Before running commands that could expose secrets, read `.codex/rules/secret-safety.md`.' },
        ],
      };
    }
    return { status: 'pass', reason: 'ok', operations: generated };
  }

  return { status: 'fail', reason: 'invalid-config', operations: [] };
}

export { CURSOR_ADAPTER_PATH, cursorAdapter };
