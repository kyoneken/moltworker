---
name: harness-setup
description: Safely retrieve the fixed source and install the visible APM harness.
---

# Harness setup

Use the GitHub MCP Server to read every file named in `harness/source-lock.json`
at its exact `repository` and 40-character `ref`. Do not use git, HTTP clients,
or an APM remote dependency to retrieve the source.

Before materializing a file, reject an absolute path, `..` path segment,
symlink, or submodule. Write the MCP-fetched files only below
`.harness/source/coding-agent-harness`, calculate SHA-256 for each result, and
compare it with the lock before APM install. Stop when the GitHub MCP connection
is unavailable or a file cannot be verified; do not substitute another ref.

Run `node scripts/harness.mjs source --target <one-target>` only after all
hashes match. Then run the root APM commands shown in `docs/harness-setup.md`:
`apm install --only apm --target <target> --frozen`, followed by
`apm install --only mcp --target <target> --frozen` for Codex, Claude, and
Cursor. Run `apm compile --target <target> --root .harness/compiled/<target>`
to keep generated instruction context separate from an existing `AGENTS.md`.
Run the Cursor adapter after its APM install; use the native Grok MCP commands,
and skip remote MCP for Antigravity. APM is intentionally visible in the
repository's root `apm.yml`; do not hide it behind another wrapper.

Use `node scripts/harness.mjs verify --target <target>` for a read-only check
of the locked source and native files, and `doctor --target <target>` for the
non-live report. APM owns installation and cleanup; review its dry-run output
before removing generated files. Never delete or overwrite an existing native
configuration to resolve a collision.
