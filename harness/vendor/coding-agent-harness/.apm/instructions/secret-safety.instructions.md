---
description: Keep secret material outside repository and agent context.
applyTo: "**/*"
---

# Secret safety

Never place secret values in Git-tracked files, APM manifests or lockfiles, `AGENTS.md`, MCP command arguments, prompts, chat output, or logs. Do not print broad environment dumps and do not retrieve raw secret values with `op read`.

Treat `.env` as local runtime material only. Do not create, persist, stage, review, or summarize its values. The tracked `.envrc.example` may contain only the non-secret `CAH_OP_ACCOUNT` and `CAH_OP_ENVIRONMENT` hints. They are neither 1Password MCP selectors nor an authorization boundary.

Use the local `1password-mcp` integration only for authorized Environment operations. It may return variable or Environment names, but never request or echo secret values. Ask for the user's approval when 1Password Desktop asks to authorize access to an Environment.

The actual authorization boundary is 1Password Environment/Vault permissions plus per-Environment user approval. Hooks and repository checks are defense in depth; they cannot replace those controls. If the same 1Password Desktop principal has access to both Environment A and Environment B, this repository cannot enforce a hard A/B binding. That requires a future broker or a separately authorized principal.

For GitHub App credentials, model `GITHUB_APP_PRIVATE_KEY` as secret; `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_WEBHOOK_SECRET` are optional secrets. `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` are non-secret identifiers. A future broker, not this harness, may create a JWT and obtain a short-lived installation token.
