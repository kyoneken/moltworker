const DOCS_URL = 'https://docs.mcp.cloudflare.com/mcp';
const OBSERVABILITY_URL = 'https://observability.mcp.cloudflare.com/mcp';
const REMOTE_TARGETS = new Set(['codex', 'claude', 'cursor', 'grok-build']);

export function cloudflarePlan({ target, profile = 'base', existing = {} } = {}) {
  if (target === 'antigravity') return { target, status: 'skipped', reason: 'incompatible', servers: [] };
  if (!REMOTE_TARGETS.has(target) || !['base', 'observability'].includes(profile) || existing === null || typeof existing !== 'object' || Array.isArray(existing)) return { target, status: 'fail', reason: 'invalid-config', servers: [] };
  const servers = [{ name: 'cloudflare-docs', url: DOCS_URL, transport: 'streamable-http', managed: true }];
  if (profile === 'observability') servers.push({ name: 'cloudflare-observability', url: OBSERVABILITY_URL, transport: 'streamable-http', managed: true });
  const conflicts = servers.filter((server) => existing[server.name] && existing[server.name].url !== server.url);
  if (conflicts.length) return { target, status: 'fail', reason: 'conflict', servers: [] };
  return { target, status: 'pass', reason: 'ok', servers: servers.filter((server) => !existing[server.name]) };
}

export { DOCS_URL, OBSERVABILITY_URL };
