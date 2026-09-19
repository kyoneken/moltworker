import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const attestConfigPath = resolve(process.cwd(), 'wrangler.attest.jsonc');
const mainConfigPath = resolve(process.cwd(), 'wrangler.jsonc');

describe('attest wrangler configuration', () => {
  it('declares a separate worker with KV and the attest hostname', () => {
    const config = readFileSync(attestConfigPath, 'utf8');
    expect(config).toMatch(/"name"\s*:\s*"moltworker-attest"/);
    expect(config).toMatch(/"main"\s*:\s*"src\/attest\/index.ts"/);
    expect(config).toMatch(/"binding"\s*:\s*"ATTEST_KV"/);
    expect(config).toMatch(/attest\.kentymyty\.com/);
    expect(config).toMatch(/APP_ATTEST_APP_ID/);
    expect(config).not.toMatch(/"class_name"\s*:\s*"Sandbox"/);
    expect(config).not.toMatch(/containers/);
  });

  it('does not attach attest KV or hostname to the sandbox worker', () => {
    const config = readFileSync(mainConfigPath, 'utf8');
    expect(config).toMatch(/"name"\s*:\s*"moltbot-sandbox"/);
    expect(config).toMatch(/moltbot\.kentymyty\.com/);
    expect(config).not.toMatch(/"pattern"\s*:\s*"attest\.kentymyty\.com"/);
    expect(config).not.toMatch(/ATTEST_KV/);
  });
});
