import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { evaluateEvent } from '../../.codex/hooks/github-policy.mjs';

const deny = (reason) => ({ permission: 'deny', user_message: reason });
const allow = () => ({ permission: 'allow' });

function guardCommand(command) {
  if (typeof command !== 'string') return false;
  const guard = join(process.cwd(), '.cursor/hooks/coding-agent-harness/scripts/secret-command-guard.sh');
  const result = spawnSync('/bin/sh', [guard], {
    input: JSON.stringify({ command }), encoding: 'utf8', timeout: 5_000,
    maxBuffer: 65_536, stdio: ['pipe', 'ignore', 'ignore'],
  });
  return !result.error && result.status === 0;
}

function evaluate(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return deny('Malformed hook input');
  if (event.tool_name === 'Shell') {
    if (!guardCommand(event.tool_input?.command)) return deny('Blocked by secret safety policy');
    const result = evaluateEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: event.tool_input.command } });
    return result.allowed ? allow() : deny(result.reason ?? 'Blocked by repository policy');
  }
  if (event.mcp_server_name !== 'github') return allow();
  if (typeof event.tool_name !== 'string') return deny('Malformed GitHub MCP input');
  let toolInput;
  try {
    toolInput = typeof event.tool_input === 'string' ? JSON.parse(event.tool_input) : event.tool_input;
    if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) throw new Error();
  } catch { return deny('Malformed GitHub MCP input'); }
  const toolName = event.tool_name.startsWith('mcp__github__') ? event.tool_name : `mcp__github__${event.tool_name}`;
  const result = evaluateEvent({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
  return result.allowed ? allow() : deny(result.reason ?? 'Blocked by repository policy');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk.slice(0, Math.max(0, 65_537 - input.length)); });
process.stdin.on('end', () => {
  let result;
  try { result = input.length > 65_536 ? deny('Hook input too large') : evaluate(JSON.parse(input)); }
  catch { result = deny('Malformed hook input'); }
  process.stdout.write(JSON.stringify(result));
});
