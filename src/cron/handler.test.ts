import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../test-utils';

const { getSandbox } = vi.hoisted(() => ({ getSandbox: vi.fn() }));
const { prepareGateway } = vi.hoisted(() => ({ prepareGateway: vi.fn() }));
const { createSnapshot, recordBackupError } = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  recordBackupError: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox,
  Sandbox: class MockSandbox {
    readonly testOnly = true;
  },
}));
vi.mock('../gateway/lifecycle', () => ({ prepareGateway }));
vi.mock('../gateway', () => ({ prepareGateway }));
vi.mock('../persistence', () => ({ createSnapshot, recordBackupError }));

import { handleScheduled } from './handler';

afterEach(() => vi.clearAllMocks());

describe('handleScheduled', () => {
  it('wakes only for an imminent OpenClaw job', async () => {
    const now = Date.now();
    const sandbox = {};
    getSandbox.mockReturnValue(sandbox);
    prepareGateway.mockResolvedValue(null);
    const bucket = {
      get: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            version: 1,
            jobs: [{ id: 'job-1', enabled: true, schedule: { kind: 'at', atMs: now + 60_000 }, state: {} }],
          }),
        ),
      }),
    } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(prepareGateway).toHaveBeenCalledWith(sandbox, expect.any(Object));
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(recordBackupError).not.toHaveBeenCalled();
  });

  it('does not initialize the sandbox when the cron store is missing', async () => {
    const bucket = { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(getSandbox).not.toHaveBeenCalled();
    expect(prepareGateway).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it('does not snapshot when no OpenClaw job is imminent', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue({ text: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, jobs: [] })) }),
    } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(getSandbox).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
