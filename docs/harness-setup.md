# Multi-agent harness setup

The repository exposes its harness through APM. The root `apm.yml` declares
the vendored, hash-locked harness source and the base MCP servers, so a fresh
clone has every install input. APM writes only project-scoped files; it does
not copy a personal profile or retrieve credentials.

## Prerequisites

Use Node.js 22 and APM 0.29.0. Python 3.11 or later with `tomllib` is needed
only by the optional static verifier. Grok Build needs the Grok CLI for its
project-scoped MCP entries because APM does not have a Grok MCP target.
See [the user acceptance checklist](harness-acceptance.md) for native loading,
Desktop approval, and per-client evidence.

## Install from the locked source

The source revision and file hashes are recorded in
[`harness/source-lock.json`](../harness/source-lock.json). The exact files are
vendored at `harness/vendor/coding-agent-harness`; verify them before install:

```bash
node scripts/harness.mjs source --target codex
```

After the source check succeeds, run the APM commands from the repository root.
APM's `--target` is explicit so one client's files are not silently installed
for another client. Codex and Claude use the complete sequence below:
Use one target per working copy; when switching targets, APM may clean its
managed MCP entries from another client's project file.

```bash
apm install --only apm --target codex --frozen
apm install --only mcp --target codex --frozen
apm compile --target codex --root .harness/compiled/codex
node scripts/harness.mjs verify --target codex
node scripts/harness.mjs doctor --target codex
```

The first command installs the source-defined skills and Hook. The second
command adds the `1password` and Cloudflare Docs MCP entries from `apm.yml`.
`compile` writes the generated instruction context under
`.harness/compiled/codex/`; review it before merging it into an existing
`AGENTS.md`. APM merges its managed entries into native configuration; review
the diff before accepting it. `verify` checks the source and generated native
files without APM side-effects. There is no harness-owned restore state: to
remove the setup, use APM's documented uninstall/clean operation after
reviewing its dry run.

Cursor needs one extra adapter step because APM's generic Hook output uses an
uppercase `PreToolUse` key while Cursor reads lower-camel event names:

```bash
apm install --only apm --target cursor --frozen
apm install --only mcp --target cursor --frozen
node scripts/harness.mjs adapt --target cursor
apm compile --target cursor --root .harness/compiled/cursor
node scripts/harness.mjs verify --target cursor
```

Grok Build has no APM MCP target. Install its skills with APM, then register
the project-scoped MCP servers with the native CLI:

```bash
apm install --only apm --target grok-build --frozen
apm compile --target grok-build --root .harness/compiled/grok-build
grok mcp add --scope project 1password -- 1password-mcp
grok mcp add --scope project cloudflare-docs https://docs.mcp.cloudflare.com/mcp
node scripts/harness.mjs verify --target grok-build
```

Antigravity receives the APM skills and Hook only. Its project-local remote MCP
schema is not verified, so do not run the MCP install for that target:

```bash
apm install --only apm --target antigravity --frozen
apm compile --target antigravity --root .harness/compiled/antigravity
node scripts/harness.mjs verify --target antigravity
```

## 1Password MCP

The root manifest declares the local command-only server `1password-mcp`.
APM adds it when `apm install --only mcp --target <target>` runs. Codex, Claude
Code, and Cursor receive the entry through APM. Grok Build uses the equivalent
native command shown below; Antigravity remains unsupported for project MCP.
1Password Desktop may ask for approval when the server first accesses an
Environment. Approve only the intended Environment; never add an account
selector, secret, token, or environment override to the MCP entry. See
[`onepassword.md`](../skills/harness-setup/references/onepassword.md).

```bash
grok mcp add --scope project 1password -- 1password-mcp
```

## Cloudflare MCP

The base manifest adds Cloudflare Docs at
`https://docs.mcp.cloudflare.com/mcp`. Docs is a public documentation service.
To add Observability, use APM's explicit self-defined MCP command and then
re-run the target install:

```bash
apm install --mcp cloudflare-observability --transport streamable-http \
  --url https://observability.mcp.cloudflare.com/mcp --target codex
apm install --only mcp --target codex --frozen
```

Use `claude` or `cursor` as the target for those clients and run the Cursor
adapter afterward. Grok Build uses its native project MCP command for
Observability; Antigravity has no verified project-local remote MCP schema.

Observability requires the selected client's OAuth sign-in; keep tokens in the
client's secure store. Antigravity project-local remote MCP is not configured
by this harness. The harness does not proxy or persist those tokens. See
[`cloudflare.md`](../skills/harness-setup/references/cloudflare.md).

## Validation

Run the synthetic checks before using a live client:

```bash
npm run test:harness
```

The tests do not contact 1Password, GitHub, Cloudflare, or any agent runtime.
Live MCP handshakes remain a per-user acceptance step and are reported as
`not-verified` until the selected client performs its own read check.

## Python detection and a fresh checkout

The optional verifier probes `python3`, versioned Python 3.11–3.14 commands,
then `python` for Python 3.11+ with `tomllib`. A command named `python3.11` is
not required. Set `HARNESS_PYTHON_COMMAND` to an executable path if automatic
selection is unsuitable; an invalid override fails explicitly. Missing Python
is reported as `missing-command`, separately from invalid TOML.

Checking out the branch includes the tracked vendor source. `source` verifies
every file against `harness/source-lock.json` before APM changes project
configuration. A missing or different vendor file reports `source-mismatch`
and leaves project configuration unchanged. Updating the harness means
updating the vendored files and lock hashes together; do not add a source
repository `.git` directory or untracked extras.
