import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const aiConfigPath = resolve(process.cwd(), 'wrangler.ai.jsonc');
const mainConfigPath = resolve(process.cwd(), 'wrangler.jsonc');
const packageJsonPath = resolve(process.cwd(), 'package.json');

describe('ai wrangler configuration', () => {
  it('declares a Free-plan AI worker with the AI binding only', () => {
    const config = readFileSync(aiConfigPath, 'utf8');
    expect(config).toMatch(/"name"\s*:\s*"moltworker-ai"/);
    expect(config).toMatch(/"main"\s*:\s*"src\/ai-worker\/index\.ts"/);
    expect(config).toMatch(/"binding"\s*:\s*"AI"/);
    expect(config).not.toMatch(/"class_name"\s*:\s*"Sandbox"/);
    expect(config).not.toMatch(/"containers"\s*:/);
    expect(config).not.toMatch(/"durable_objects"\s*:/);
    expect(config).not.toMatch(/"r2_buckets"\s*:/);
    expect(config).not.toMatch(/"browser"\s*:/);
    expect(config).not.toMatch(/"kv_namespaces"\s*:/);
  });

  it('keeps the AI binding on the sandbox worker for backward compatibility', () => {
    const config = readFileSync(mainConfigPath, 'utf8');
    expect(config).toMatch(/"binding"\s*:\s*"AI"/);
  });

  it('exposes deploy:ai and fails the default deploy script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['deploy:ai']).toMatch(/wrangler\.ai\.jsonc/);
    expect(pkg.scripts['dev:ai']).toMatch(/wrangler\.ai\.jsonc/);
    expect(pkg.scripts.deploy).toMatch(/deprecated-sandbox-deploy/);
    expect(pkg.scripts['deploy:sandbox']).toMatch(/wrangler deploy/);
    expect(pkg.scripts['deploy:attest']).toMatch(/wrangler\.attest\.jsonc/);
  });
});
