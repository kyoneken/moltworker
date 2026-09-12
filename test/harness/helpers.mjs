import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'moltworker-harness-'));
}

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true });
}

export async function write(root, relativePath, contents) {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

export async function read(root, relativePath) {
  return readFile(join(root, relativePath), 'utf8');
}

export async function runHarness(args, { root, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/harness.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function readManagedConfiguration(root) {
  const config = JSON.parse(await read(root, '.codex/hooks.json'));
  return config.hooks.PreToolUse;
}

export async function readUnmanagedConfiguration(root) {
  const config = JSON.parse(await read(root, '.codex/settings.json'));
  const { harness, ...unmanaged } = config;
  return unmanaged;
}

// Public synthetic provider output; no private source or live credentials.
export const fakeProviderOutput = `
const providerPath = { codex: '.codex/config.toml', claude: '.mcp.json', cursor: '.cursor/mcp.json', 'grok-build': '.grok/config.toml' }[target];
if (providerPath) {
  mkdirSync(join(process.cwd(), providerPath, '..'), { recursive: true });
  writeFileSync(join(process.cwd(), providerPath), providerPath.endsWith('.toml')
    ? '[mcp_servers."1password"]\\ncommand = "1password-mcp"\\n'
    : JSON.stringify({ mcpServers: { '1password': { command: '1password-mcp' } } }));
}
`;
