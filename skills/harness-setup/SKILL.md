---
name: harness-setup
description: Safely retrieve and install the fixed coding-agent harness source.
---

# Harness setup

Use the GitHub MCP Server to read every file named in `harness/source-lock.json`
at its exact `repository` and 40-character `ref`. Do not use git, HTTP clients,
or an APM remote dependency to retrieve the source.

Before materializing a file, reject an absolute path, `..` path segment,
symlink, or submodule. Write the MCP-fetched files only below
`.harness/source/coding-agent-harness`, calculate SHA-256 for each result, and
compare it with the lock before bootstrap. Stop when the GitHub MCP connection
is unavailable or a file cannot be verified; do not substitute another ref.

Run `node scripts/harness.mjs bootstrap --target <one-target> --source
.harness/source/coding-agent-harness` only after all hashes match. The wrapper
uses a temporary local APM project and does not run APM in the repository root.
Review the structured result; it records configuration generation separately
from native-client loading and any live authentication check.

Use `verify` for the static source check, `doctor --json` for a
non-live report, and `restore` only after reviewing a clean result. Restore
stops if a managed value or block has changed since installation.
