import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../test-utils';

const { getSandbox } = vi.hoisted(() => ({ getSandbox: vi.fn() }));
const { prepareGateway } = vi.hoisted(() => ({ prepareGateway: vi.fn() }));
const { createSnapshot } = vi.hoisted(() => ({ createSnapshot: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox }));
vi.mock('../gateway/lifecycle', () => ({ prepareGateway }));
vi.mock('../gateway', () => ({ prepareGateway }));
vi.mock('../persistence', () => ({ createSnapshot }));

import { handleScheduled } from './handler';

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleScheduled', () => {
  it('prepares persisted gateway state when a job is imminent and still snapshots', async () => {
    const now = Date.now();
    const sandbox = {};
    getSandbox.mockReturnValue(sandbox);
    prepareGateway.mockResolvedValue(null);
    createSnapshot.mockResolvedValue({ id: 'snap', dir: '/home/openclaw' });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            version: 1,
            jobs: [
              {
                id: 'job-1',
                enabled: true,
                schedule: { kind: 'at', atMs: now + 60_000 },
                state: {},
              },
            ],
          }),
        ),
      }),
    } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(prepareGateway).toHaveBeenCalledWith(sandbox, expect.any(Object));
    expect(createSnapshot).toHaveBeenCalledWith(sandbox, bucket, 'cron');
  });

  it('still takes a snapshot when the OpenClaw cron store is missing', async () => {
    const sandbox = {};
    getSandbox.mockReturnValue(sandbox);
    prepareGateway.mockResolvedValue(null);
    createSnapshot.mockResolvedValue({ id: 'snap', dir: '/home/openclaw' });
    const bucket = { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(createSnapshot).toHaveBeenCalledWith(sandbox, bucket, 'cron');
  });

  it('still takes a snapshot when no OpenClaw job is in the lead window', async () => {
    const sandbox = {};
    getSandbox.mockReturnValue(sandbox);
    createSnapshot.mockResolvedValue({ skipped: true, id: 'old', dir: '/home/openclaw' });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue(
          JSON.stringify({ version: 1, jobs: [] }),
        ),
      }),
    } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(createSnapshot).toHaveBeenCalled();
  });

  it('still takes a snapshot when OpenClaw wake throws', async () => {
    const sandbox = {};
    getSandbox.mockReturnValue(sandbox);
    prepareGateway.mockRejectedValueOnce(new Error('wake failed'));
    createSnapshot.mockResolvedValue({ id: 'snap', dir: '/home/openclaw' });
    const now = Date.now();
    const bucket = {
      get: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            version: 1,
            jobs: [
              {
                id: 'job-1',
                enabled: true,
                schedule: { kind: 'at', atMs: now + 60_000 },
                state: {},
              },
            ],
          }),
        ),
      }),
    } as unknown as R2Bucket;

    await handleScheduled(createMockEnv({ BACKUP_BUCKET: bucket }));

    expect(createSnapshot).toHaveBeenCalled();
  });
});
