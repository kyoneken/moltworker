# Harness support matrix

| Target | Instructions | Skills | Hooks | 1Password MCP | Cloudflare Docs/Observability |
| --- | --- | --- | --- | --- | --- |
| Codex CLI | `AGENTS.md` | `.agents/skills` | `.codex/hooks.json` | supported | remote OAuth |
| Claude Code | `.claude/rules` | `.claude/skills` | `.claude/settings.json` | supported | remote OAuth |
| Cursor | `.cursor/rules` | `.agents/skills` | `.cursor/hooks.json` | supported | remote OAuth |
| Grok Build | `.grok/rules` | `.grok/skills` | native hook unsupported | supported through project CLI | remote OAuth |
| Antigravity | `.agents/rules` | `.agents/skills` | `.agents/hooks.json` | incompatible | project-local integration unsupported |

The table describes the target mapping, not a claim that every live runtime is
installed on the current machine. `node scripts/harness.mjs doctor --target <target>` verifies recorded
installation state while leaving native loading, authentication and live
operations as `not-verified`. The connected-agent diagnostic skill separates
tool presence, authentication, permission, and completion. A successful config
read does not imply that an MCP server was launched or that OAuth succeeded.

## GitHub MCP diagnostics

GitHub Issues and GitHub Projects are independent checks. A connected agent may
have permission to read Issues while lacking Project access, and the harness
must preserve that distinction. Use the GitHub MCP Server for both checks; do
not substitute `gh`, curl, or a raw REST/GraphQL request. See
[`github.md`](../skills/harness-doctor/references/github.md) for the diagnostic
matrix and required evidence.

## Known limitations

The harness does not migrate a user's global profile, copy secret values, or
create a local proxy for remote MCP servers. Native hook and MCP handshake
evidence is client-specific. If a target cannot represent an owned operation,
the doctor output must report `incompatible` or `not-verified` rather than
silently claiming parity.

## User acceptance

Follow [the Japanese acceptance checklist](harness-acceptance.md). Record
configuration generation, native client loading, Hook execution, MCP handshake,
and authentication separately. The original PR's generation-only results do
not establish live compatibility of the reviewed implementation.

## Native schema evidence

Cursor uses project `.cursor/hooks.json`, lower-camel `preToolUse` and
`beforeMCPExecution`, and flat command entries. MCP attribution uses
`mcp_server_name`, not a server launch command. See the
[official Cursor Hooks documentation](https://cursor.com/docs/hooks)
(checked 2026-09-12). Adapter tests use synthetic documented events; they are
not evidence of a live client callback. Antigravity remote project MCP is
skipped because this harness has no verified project-scoped schema for it.
