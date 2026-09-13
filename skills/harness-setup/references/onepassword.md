# 1Password MCP

Codex, Claude Code, Cursor, and Grok Build use a project-local stdio entry with
`command = "1password-mcp"`, no arguments, and no environment overrides.
Antigravity is explicitly incompatible in the pinned compatibility check and is
left without a generated 1Password entry.

Desktop approval is performed by the user. The setup flow may verify command
availability or Environment names, but never requests, prints, or stores secret
values. Do not use `op read`, copy a mount into an agent prompt, or generate a
plaintext `.dev.vars` file. Lockfile changes can require Desktop approval again.
