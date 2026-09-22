#!/usr/bin/env node
/**
 * Default `npm run deploy` is deprecated for this fork.
 * Supported Free-plan workers: deploy:attest, deploy:ai
 */
console.error(`
ERROR: \`npm run deploy\` is deprecated in this fork.

Supported Free-plan deploy targets:
  npm run deploy:attest   # App Attest Worker (Workers + KV)
  npm run deploy:ai       # Workers AI OpenAI-compatible proxy

Paid Sandbox / OpenClaw hosting is unsupported here. If you still need it:
  npm run deploy:sandbox  # Paid containers path — not maintained
`);
process.exit(1);
