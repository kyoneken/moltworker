import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from './test-utils';

const { BaseSandbox } = vi.hoisted(() => {
  class BaseSandbox {
    env: unknown;
    superOnActivityExpired = vi.fn().mockResolvedValue(undefined);

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }

    async onActivityExpired(): Promise<void> {
      await this.superOnActivityExpired();
    }
  }
  return { BaseSandbox };
});
const { createSnapshot, recordBackupError } = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  recordBackupError: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ Sandbox: BaseSandbox, getSandbox: vi.fn() }));
vi.mock('./persistence', () => ({ createSnapshot, recordBackupError }));

import { Sandbox } from './index';

afterEach(() => vi.clearAllMocks());

describe('Sandbox activity expiry', () => {
  it('snapshots idle state before delegating shutdown', async () => {
    const env = createMockEnv();
    const sandbox = new Sandbox({} as DurableObjectState<{}>, env) as unknown as {
      onActivityExpired: () => Promise<void>;
      superOnActivityExpired: ReturnType<typeof vi.fn>;
    };
    createSnapshot.mockResolvedValue({ id: 'snapshot', dir: '/home/openclaw' });

    await sandbox.onActivityExpired();

    expect(createSnapshot).toHaveBeenCalledWith(sandbox, env.BACKUP_BUCKET, 'idle');
    expect(sandbox.superOnActivityExpired).toHaveBeenCalledOnce();
  });

  it('records snapshot errors and still delegates shutdown', async () => {
    const env = createMockEnv();
    const sandbox = new Sandbox({} as DurableObjectState<{}>, env) as unknown as {
      onActivityExpired: () => Promise<void>;
      superOnActivityExpired: ReturnType<typeof vi.fn>;
    };
    createSnapshot.mockRejectedValue(new Error('snapshot failed'));
    recordBackupError.mockResolvedValue(undefined);

    await expect(sandbox.onActivityExpired()).resolves.toBeUndefined();

    expect(recordBackupError).toHaveBeenCalledWith(env.BACKUP_BUCKET, 'idle-snapshot-failed');
    expect(sandbox.superOnActivityExpired).toHaveBeenCalledOnce();
  });
});
