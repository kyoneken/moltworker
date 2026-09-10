# Multi-agent harness setup

The harness gives Codex CLI, Claude Code, Cursor, Grok Build, and Antigravity
the same project-scoped instructions, skills, hooks, and MCP onboarding rules.
It installs one target per invocation and never copies a personal profile into
the repository.

## Install from the locked source

The source revision and file hashes are recorded in
[`harness/source-lock.json`](../harness/source-lock.json). Obtain that exact
revision through the GitHub MCP Server, place it in a private directory, and
run:

```bash
node scripts/harness.mjs bootstrap \
  --target codex \
  --source /private/path/coding-agent-harness
```

Change `--target` to `claude`, `cursor`, `grok-build`, or `antigravity` for a
different client. Run `verify` before sharing a workspace and `restore` when
the project-owned changes should be removed. Both commands use the recorded
state and fail closed on a source mismatch or manual edit.

## 1Password MCP

Codex, Claude Code, Cursor, and Grok Build use the local command-only server
`1password-mcp`. Antigravity is marked incompatible because it cannot express
the required local MCP setup. 1Password Desktop may ask for approval when the
server first accesses an Environment. Approve only the intended Environment;
never add an account selector, secret, token, or environment override to the
MCP entry. See [`onepassword.md`](../skills/harness-setup/references/onepassword.md)
for the complete safety contract.

## Cloudflare MCP

The base profile uses Cloudflare Docs at
`https://docs.mcp.cloudflare.com/mcp`. The optional observability profile adds
`https://observability.mcp.cloudflare.com/mcp`. These are remote OAuth servers;
complete sign-in in the selected client and keep tokens in the client's secure
store. The harness does not proxy or persist those tokens. See
[`cloudflare.md`](../skills/harness-setup/references/cloudflare.md).

## Validation

Run the synthetic checks before using a live client:

```bash
npm run test:harness
```

The tests do not contact 1Password, GitHub, Cloudflare, or any agent runtime.
Live MCP handshakes remain a per-user acceptance step and are reported as
`not-verified` until the selected client performs its own read check.
