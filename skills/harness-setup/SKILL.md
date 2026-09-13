---
name: harness-setup
description: Verify the vendored fixed source and install the visible APM harness.
---

# Harness setup

The exact source files named in `harness/source-lock.json` are vendored below
`harness/vendor/coding-agent-harness`. Do not retrieve a second copy through
git, HTTP clients, or an APM remote dependency.

Before APM install, check the vendor tree for extra files, symlinks, and
submodules. `node scripts/harness.mjs source --target <one-target>` calculates
SHA-256 for every locked file and compares it with the fixed repository, ref,
and APM version. Stop on any mismatch; do not substitute another ref.

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
