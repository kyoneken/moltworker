---
name: harness-doctor
description: Diagnose coding-agent MCP availability, authentication, and permissions without probing writes.
---

# Harness doctor

Run diagnostics in separate dimensions. First inspect the connected tool
inventory, then read `get_me`, an allowed `kyoneken/moltworker` Issue, and the
requested Project fields/items independently. A failed `get_me` or Project
read does not prove that Issue reads are disconnected.

Record only the fixed result vocabulary from `scripts/harness/report.mjs`.
Never include raw MCP payloads, tokens, headers, cookies, or stderr. A read
success does not imply write permission. Do not create Issues, comments, or
Project updates as a probe.

For local stdio GitHub MCP, `GITHUB_TOOLSETS=default,projects` is distinct from
remote HTTP's `X-MCP-Toolsets: default,projects`. Preserve the user's existing
credential and transport configuration.
