---
name: harness-workflow
description: Use the shared moltworker development workflow from any supported coding agent.
---

# Harness workflow

Use the selected client's native rules and hooks together with the repository
rules in `AGENTS.md` and `skills/`. Keep the fork boundary, GitHub MCP-only
operation rule, and human PR merge gate in force.

Report each task with exactly these fields: `status`, `changed`, `verified`,
`decisions`, and `blockers`. Include the relevant Sub-issue and PR when known.

Codex can delegate independent work to the configured worker profiles. Clients
without independent subagents run the same responsibility split sequentially
and report when independent review is unavailable. Never copy a Codex profile
into another client's configuration.

`cloudflare-browser` is an OpenClaw runtime skill. Do not automatically expose
it as a coding-agent MCP server.
