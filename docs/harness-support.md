# Harness support matrix

| Target | Instructions | Skills | Hooks | 1Password MCP | Cloudflare Docs/Observability |
| --- | --- | --- | --- | --- | --- |
| Codex CLI | `AGENTS.md` | `.agents/skills` | `.codex/hooks.json` | supported | remote OAuth |
| Claude Code | `.claude/rules` | `.claude/skills` | `.claude/settings.json` | supported | remote OAuth |
| Cursor | `.cursor/rules` | `.agents/skills` | `.cursor/hooks.json` | supported | remote OAuth |
| Grok Build | `.grok/rules` | `.grok/skills` | native hook unsupported | supported through project CLI | remote OAuth |
| Antigravity | `.agents/rules` | `.agents/skills` | `.agents/hooks.json` | incompatible | remote OAuth |

The table describes the target mapping, not a claim that every live runtime is
installed on the current machine. `harness doctor` separates configuration,
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
