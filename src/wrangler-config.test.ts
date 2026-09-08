import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wranglerConfigPath = resolve(process.cwd(), 'wrangler.jsonc');

describe('wrangler configuration', () => {
  it('configures exactly one six-hour backup cron', () => {
    const wranglerConfig = readFileSync(wranglerConfigPath, 'utf8');

    expect(wranglerConfig).toMatch(/"triggers"\s*:/);
    expect(wranglerConfig).toMatch(/"crons"\s*:\s*\[\s*"0 \*\/6 \* \* \*"\s*\]/);
    expect(wranglerConfig.match(/"crons"\s*:/g)).toHaveLength(1);
    expect(wranglerConfig).not.toMatch(/\* \* \* \* \*/);
  });
});
