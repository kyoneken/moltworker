# Multi-agent harness setup

The harness gives Codex CLI, Claude Code, Cursor, Grok Build, and Antigravity
a shared project workflow with client-specific instructions, skills, hooks, and MCP support.
It installs one target per invocation and never copies a personal profile into
the repository.

## Prerequisites

Use Node.js 22, APM 0.29.0, and Python 3.11 or later with `tomllib`.
Only Grok Build requires the Grok CLI for project-scoped MCP registration.
See [the user acceptance checklist](harness-acceptance.md) for native loading,
Desktop approval, and per-client evidence.

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
the project-owned changes should be removed. Verify checks both the locked source and installed ownership state. Restore
uses the ownership state to undo the preceding managed change and stops on a
manual edit; it does not require the source directory.

## 1Password MCP

Codex, Claude Code, Cursor, and Grok Build use the local command-only server
`1password-mcp`. This harness marks Antigravity integration incompatible; a supported
project-local MCP schema has not been verified for this target. 1Password Desktop may ask for approval when the
server first accesses an Environment. Approve only the intended Environment;
never add an account selector, secret, token, or environment override to the
MCP entry. See [`onepassword.md`](../skills/harness-setup/references/onepassword.md)
for the complete safety contract.

## Cloudflare MCP

The base profile uses Cloudflare Docs at
`https://docs.mcp.cloudflare.com/mcp`. The optional observability profile adds
`https://observability.mcp.cloudflare.com/mcp`. Docs is a public documentation service. Observability requires the
selected client's OAuth sign-in; keep tokens in the client's secure store.
Antigravity project-local remote MCP is not configured by this harness. The harness does not proxy or persist those tokens. See
[`cloudflare.md`](../skills/harness-setup/references/cloudflare.md).

## Validation

Run the synthetic checks before using a live client:

```bash
npm run test:harness
```

The tests do not contact 1Password, GitHub, Cloudflare, or any agent runtime.
Live MCP handshakes remain a per-user acceptance step and are reported as
`not-verified` until the selected client performs its own read check.
