---
name: onepassword-environments
description: Safely manage authorized 1Password Environments through the local MCP server.
---

# 1Password Environments

Use this skill only for an authorized 1Password Environment operation. The package declares a local stdio MCP server named `1password` with the `1password-mcp` command. It carries no arguments, environment overrides, or secret configuration.

The target-scoped package configures this server for Codex, Claude Code, and Cursor. Claude Code uses the project `.mcp.json`, and Cursor uses `.cursor/mcp.json`; Grok Build remains the CLI-managed `.grok/config.toml` exception. No new environment variable is provisioned. If runtime configuration is required in the future, use a placeholder reference such as `${env:VARIABLE_NAME}` without adding a value; split target-specific overlays before introducing client-specific variable names.

On Grok Build, APM 0.29 does not configure the 1Password MCP. `scripts/bootstrap` manages the documented project-scoped Grok Build configuration. Grok Build 1.0.13 was observed to update the same project server in place when bootstrap is repeated. Do not manually create or copy `.grok/config.toml`, use global configuration, or introduce a proxy or shim.

Before acting, state the intended Environment operation without naming or exposing values. Let 1Password Desktop authenticate and obtain approval for the specific Environment. Use names and metadata only when they are sufficient. Never request, display, copy, persist, or log secret values.

A local Environment mount can expose `.env` through a UNIX pipe, and an authorized runtime process may read the resulting values. Therefore, do not claim that context exposure is impossible. Do not persist a mount, add `.env` to the repository, or use broad environment dumps.

`CAH_OP_ACCOUNT` and `CAH_OP_ENVIRONMENT` are optional harness-only, non-secret local hints. They are not official 1Password MCP selectors and do not constrain access. Environment/Vault permissions and per-Environment approval remain the authorization boundary. A common Desktop principal with access to multiple Environments cannot be hard-bound to this repository; record that limitation and defer broker design.

Service accounts can be scoped to a vault or Environment, but their token is secret and they do not supply Desktop MCP authorization. Do not use one in this harness. A future broker may use a separately managed service-account identity.
