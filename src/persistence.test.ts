import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import { createMockExecResult } from './test-utils';
import {
  clearPersistenceCache,
  classifyBackupHealth,
  createSnapshot,
  hasUsableBackup,
  reconcileBackupAuthority,
  restoreIfNeeded,
  reserveRestore,
  cancelRestoreReservation,
  setBackupRetention,
  getBackupStatus,
  BackupOperationLeaseTimeoutError,
  withBackupOperationLease,
} from './persistence';

const oldHandle = { id: 'old-backup', dir: '/home/openclaw' };
const newHandle = { id: 'new-backup', dir: '/home/openclaw' };
const validBackupHandle = { id: '11111111-1111-4111-8111-111111111111', dir: '/home/openclaw' };

afterEach(() => {
  vi.useRealTimers();
});

function memoryLeaseBucket(): R2Bucket {
  let current: R2Object | null = null;
  let version = 0;
  return {
    head: vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === 'backup-operation-lock' ? current : null,
      ),
    put: vi.fn().mockImplementation(async (key: string, _value: string, options?: R2PutOptions) => {
      if (key !== 'backup-operation-lock') return undefined;
      const onlyIf = options?.onlyIf as R2Conditional;
      const allowed =
        (onlyIf.etagDoesNotMatch === '*' && current === null) ||
        onlyIf.etagMatches === current?.etag;
      if (!allowed) return null;
      version += 1;
      current = {
        etag: `lease-${version}`,
        customMetadata: options?.customMetadata,
      } as R2Object;
      return current;
    }),
  } as unknown as R2Bucket;
}

describe('backup operation lease', () => {
  it('serializes a snapshot-style operation and a competing restart-style operation', async () => {
    vi.useFakeTimers();
    const bucket = memoryLeaseBucket();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let signalFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });

    const snapshot = withBackupOperationLease(bucket, async () => {
      order.push('snapshot');
      signalFirst?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstEntered;
    const restart = withBackupOperationLease(bucket, async () => {
      order.push('restart');
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(['snapshot']);
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([snapshot, restart]);
    expect(order).toEqual(['snapshot', 'restart']);
  });

  it('times out without modifying an active lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const active = {
      etag: 'other-owner',
      customMetadata: { owner: 'other', expiresAt: '240000' },
    } as unknown as R2Object;
    const bucket = {
      head: vi.fn().mockResolvedValue(active),
      put: vi.fn(),
    } as unknown as R2Bucket;

    const operation = withBackupOperationLease(bucket, async () => undefined).then(
      () => undefined,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(operation).resolves.toBeInstanceOf(BackupOperationLeaseTimeoutError);
    expect(vi.mocked(bucket.put)).not.toHaveBeenCalled();
  });

  it('releases a slow successful CAS acquisition after its deadline without running the operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const put = vi
      .fn()
      .mockImplementationOnce(async () => {
        vi.setSystemTime(10_001);
        return { etag: 'late-etag', customMetadata: { owner: 'late', expiresAt: '240000' } };
      })
      .mockResolvedValue({ etag: 'released-etag' });
    const bucket = {
      head: vi.fn().mockResolvedValue(null),
      put,
    } as unknown as R2Bucket;
    const operation = vi.fn();

    await expect(withBackupOperationLease(bucket, operation)).rejects.toBeInstanceOf(
      BackupOperationLeaseTimeoutError,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(
      'backup-operation-lock',
      '',
      expect.objectContaining({
        onlyIf: { etagMatches: 'late-etag' },
        customMetadata: expect.objectContaining({ expiresAt: '0' }),
      }),
    );
  });

  it('cannot clobber a successor lease with a late release', async () => {
    let current: R2Object | null = null;
    const successor = {
      etag: 'successor-etag',
      customMetadata: { owner: 'successor', expiresAt: String(Date.now() + 240_000) },
    } as unknown as R2Object;
    const bucket = {
      head: vi.fn().mockImplementation(async () => current),
      put: vi
        .fn()
        .mockImplementation(async (_key: string, _value: string, options: R2PutOptions) => {
          const onlyIf = options.onlyIf as R2Conditional;
          const allowed =
            (onlyIf.etagDoesNotMatch === '*' && current === null) ||
            onlyIf.etagMatches === current?.etag;
          if (!allowed) return null;
          current = {
            etag: 'owner-etag',
            customMetadata: options.customMetadata,
          } as R2Object;
          return current;
        }),
    } as unknown as R2Bucket;

    await withBackupOperationLease(bucket, async () => {
      current = successor;
    });

    expect(current).toBe(successor);
  });

  it('renews the lease while a long createBackup is still running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let current: R2Object | null = null;
    let version = 0;
    let unblockCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const bucket = {
      get: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(oldHandle) }),
      head: vi
        .fn()
        .mockImplementation(async (key: string) =>
          key === 'backup-operation-lock' ? current : null,
        ),
      put: vi
        .fn()
        .mockImplementation(async (key: string, _value: string, options?: R2PutOptions) => {
          if (key !== 'backup-operation-lock') return { etag: `${key}-etag` } as R2Object;
          const onlyIf = options?.onlyIf as R2Conditional;
          const allowed =
            (onlyIf.etagDoesNotMatch === '*' && current === null) ||
            onlyIf.etagMatches === current?.etag;
          if (!allowed) return null;
          version += 1;
          current = {
            etag: `lease-${version}`,
            customMetadata: options?.customMetadata,
          } as R2Object;
          return current;
        }),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      createBackup: vi.fn().mockImplementation(async () => {
        signalCreateStarted?.();
        await new Promise<void>((resolve) => {
          unblockCreate = resolve;
        });
        return newHandle;
      }),
    } as unknown as Sandbox;

    const snapshot = createSnapshot(sandbox, bucket);
    await createStarted;
    await vi.advanceTimersByTimeAsync(241_000);
    expect(Number((current as R2Object | null)?.customMetadata?.expiresAt)).toBeGreaterThan(
      Date.now(),
    );

    unblockCreate?.();
    await snapshot;
    expect(vi.getTimerCount()).toBe(0);
  });
});

function preflightBucket(
  options: {
    handle?: unknown;
    metadata?: unknown;
    dataSize?: number;
    malformedHandle?: boolean;
    malformedMetadata?: boolean;
  } = {},
): R2Bucket {
  const now = new Date().toISOString();
  const handle = options.handle ?? validBackupHandle;
  const metadata =
    options.metadata ??
    ({
      id: validBackupHandle.id,
      dir: validBackupHandle.dir,
      createdAt: now,
      ttl: 3600,
      sizeBytes: 123,
    } as const);
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'backup-handle.json') {
        return {
          json: vi.fn().mockImplementation(async () => {
            if (options.malformedHandle) throw new Error('invalid JSON');
            return handle;
          }),
        };
      }
      if (key === `backups/${validBackupHandle.id}/meta.json`) {
        return {
          json: vi.fn().mockImplementation(async () => {
            if (options.malformedMetadata) throw new Error('invalid JSON');
            return metadata;
          }),
        };
      }
      return null;
    }),
    head: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'backup-handle.json') return { key, size: 1 };
      if (key === `backups/${validBackupHandle.id}/meta.json`) return { key, size: 1 };
      if (key === `backups/${validBackupHandle.id}/data.sqsh`) {
        return { key, size: options.dataSize ?? 123 };
      }
      return null;
    }),
  } as unknown as R2Bucket;
}

describe('hasUsableBackup', () => {
  it('accepts a complete, SDK-restorable backup', async () => {
    await expect(hasUsableBackup(preflightBucket())).resolves.toBe(true);
  });

  it.each([
    ['an invalid UUID handle', { handle: { id: 'not-a-uuid', dir: '/home/openclaw' } }],
    ['a malformed handle object', { malformedHandle: true }],
    ['malformed backup metadata', { malformedMetadata: true }],
    [
      'metadata with a mismatched id',
      {
        metadata: {
          id: '22222222-2222-4222-8222-222222222222',
          dir: '/home/openclaw',
          createdAt: new Date().toISOString(),
          ttl: 3600,
          sizeBytes: 123,
        },
      },
    ],
    [
      'expired metadata',
      {
        metadata: {
          id: validBackupHandle.id,
          dir: '/home/openclaw',
          createdAt: new Date(Date.now() - 61_000).toISOString(),
          ttl: 1,
          sizeBytes: 123,
        },
      },
    ],
    [
      'metadata inside the SDK 60-second expiry buffer',
      {
        metadata: {
          id: validBackupHandle.id,
          dir: '/home/openclaw',
          createdAt: new Date().toISOString(),
          ttl: 30,
          sizeBytes: 123,
        },
      },
    ],
    ['an empty archive object', { dataSize: 0 }],
  ])('rejects %s', async (_label, options) => {
    await expect(hasUsableBackup(preflightBucket(options))).resolves.toBe(false);
  });
});

function backupBucket(
  settings: { createFails?: boolean; storeFails?: boolean; cleanupFails?: boolean } = {},
) {
  const events: string[] = [];
  let lock: R2Object | null = null;
  let leaseVersion = 0;
  const bucket = {
    get: vi.fn().mockImplementation(async (key: string) => {
      events.push(`get:${key}`);
      if (key === 'backup-manifest.json') return null;
      return { json: vi.fn().mockResolvedValue(oldHandle), etag: 'h0' };
    }),
    head: vi
      .fn()
      .mockImplementation(async (key: string) => (key === 'backup-operation-lock' ? lock : null)),
    put: vi.fn().mockImplementation(async (key: string, _value: string, options?: R2PutOptions) => {
      if (key === 'backup-operation-lock') {
        leaseVersion += 1;
        lock = {
          etag: `lease-${leaseVersion}`,
          customMetadata: options?.customMetadata,
        } as R2Object;
        return lock;
      }
      events.push(`put:${key}`);
      if (settings.storeFails && key === 'backup-handle.json')
        throw new Error('handle store failed');
      return { etag: `${key}-etag` } as R2Object;
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      events.push(`delete:${key}`);
      if (settings.cleanupFails && key.startsWith('backups/old-backup/')) {
        throw new Error('old cleanup failed');
      }
    }),
  } as unknown as R2Bucket;
  const sandbox = {
    exec: vi.fn().mockResolvedValue(createMockExecResult()),
    createBackup: vi.fn().mockImplementation(async () => {
      events.push('create');
      if (settings.createFails) throw new Error('create failed');
      return newHandle;
    }),
  } as unknown as Sandbox;
  return { bucket, sandbox, events };
}

describe('createSnapshot', () => {
  it('holds the shared backup-operation lease through handle replacement and old cleanup', async () => {
    const events: string[] = [];
    let lock: R2Object | null = null;
    let version = 0;
    const bucket = {
      get: vi.fn().mockImplementation(async () => {
        events.push('get:backup-handle.json');
        return { json: vi.fn().mockResolvedValue(oldHandle) };
      }),
      head: vi.fn().mockImplementation(async (key: string) => {
        events.push(`head:${key}`);
        return key === 'backup-operation-lock' ? lock : null;
      }),
      put: vi
        .fn()
        .mockImplementation(async (key: string, _value: string, options?: R2PutOptions) => {
          if (key === 'backup-operation-lock') {
            events.push('lease:put');
            const onlyIf = options?.onlyIf as R2Conditional;
            const allowed =
              (onlyIf.etagDoesNotMatch === '*' && lock === null) ||
              onlyIf.etagMatches === lock?.etag;
            if (!allowed) return null;
            version += 1;
            lock = {
              etag: `lease-${version}`,
              customMetadata: options?.customMetadata,
            } as R2Object;
            return lock;
          }
          events.push(`put:${key}`);
          return { etag: `${key}-etag` } as R2Object;
        }),
      delete: vi.fn().mockImplementation(async (key: string) => events.push(`delete:${key}`)),
    } as unknown as R2Bucket;
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      createBackup: vi.fn().mockImplementation(async () => {
        events.push('create');
        return newHandle;
      }),
    } as unknown as Sandbox;

    await createSnapshot(sandbox, bucket);

    const acquire = events.indexOf('lease:put');
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(acquire).toBeLessThan(events.indexOf('create'));
    expect(events.lastIndexOf('lease:put')).toBeGreaterThan(
      events.indexOf('put:backup-handle.json'),
    );
    expect(events).not.toContain('delete:backups/old-backup/meta.json');
  });

  it('keeps the old handle and backup objects when creating the replacement fails', async () => {
    const { bucket, sandbox, events } = backupBucket({ createFails: true });

    await expect(createSnapshot(sandbox, bucket)).rejects.toThrow('create failed');

    expect(events).toContain('create');
    expect(events).not.toContain('put:backup-handle.json');
    expect(events).not.toContain('delete:backups/old-backup/data.sqsh');
    expect(events).not.toContain('delete:backups/old-backup/meta.json');
  });

  it('keeps the previous generation when storing the new handle fails after the manifest commit', async () => {
    const { bucket, sandbox, events } = backupBucket({ storeFails: true });

    await expect(createSnapshot(sandbox, bucket)).resolves.toEqual(newHandle);

    expect(events).toContain('put:backup-manifest.json');
    expect(events).toContain('put:backup-handle.json');
    expect(events).not.toContain('delete:backups/old-backup/data.sqsh');
    expect(events).not.toContain('delete:backups/old-backup/meta.json');
  });

  it('does not delete the previous generation while history is under retention', async () => {
    const { bucket, sandbox, events } = backupBucket();

    await expect(createSnapshot(sandbox, bucket)).resolves.toEqual(newHandle);

    expect(events).toContain('put:backup-manifest.json');
    expect(events).toContain('put:backup-handle.json');
    expect(events).not.toContain('delete:backups/old-backup/data.sqsh');
    expect(events).not.toContain('delete:backups/old-backup/meta.json');
  });

  it('keeps the new handle available when old backup cleanup fails', async () => {
    const { bucket, sandbox } = backupBucket({ cleanupFails: true });

    await expect(createSnapshot(sandbox, bucket)).resolves.toEqual(newHandle);

    expect(vi.mocked(bucket.put)).toHaveBeenCalledWith(
      'backup-handle.json',
      JSON.stringify(newHandle),
    );
  });
});

describe('restoreIfNeeded', () => {
  it('keeps a newer handle and marker when an expired restore loses its conditional tombstone CAS', async () => {
    clearPersistenceCache();
    const old = { id: 'old-backup', dir: '/home/openclaw' };
    const newer = { id: 'new-backup', dir: '/home/openclaw' };
    let getCount = 0;
    const bucket = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key !== 'backup-handle.json') return null;
        getCount += 1;
        return {
          etag: getCount === 1 ? 'h0' : 'h1',
          json: vi.fn().mockResolvedValue(getCount === 1 ? old : newer),
        };
      }),
      put: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'backup-handle.json') return null;
        return { etag: `${key}-etag` };
      }),
      delete: vi.fn(),
      head: vi.fn().mockResolvedValue({ key: 'restore-needed' }),
    } as unknown as R2Bucket;
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(
            new Error(
              'Backup old-backup has expired (created: 2026-08-27T21:49:50.948Z, TTL: 604800s). Create a new backup.',
            ),
            { name: 'BackupExpiredError', code: 'BACKUP_EXPIRED' },
          ),
        )
        .mockResolvedValueOnce(undefined),
    } as unknown as Sandbox;

    await expect(restoreIfNeeded(sandbox, bucket)).rejects.toThrow('Backup handle changed');
    expect(vi.mocked(bucket.put)).toHaveBeenCalledWith('backup-handle.json', 'null', {
      onlyIf: { etagMatches: 'h0' },
    });
    expect(vi.mocked(bucket.delete)).not.toHaveBeenCalledWith('restore-needed');

    await expect(restoreIfNeeded(sandbox, bucket)).resolves.toBeUndefined();
    expect(vi.mocked(sandbox.restoreBackup)).toHaveBeenLastCalledWith(newer);
  });

  it('unmounts a stale overlay before treating an absent backup handle as clean', async () => {
    clearPersistenceCache();
    const events: string[] = [];
    const bucket = {
      get: vi.fn().mockImplementation(async (key: string) => {
        events.push(`get:${key}`);
        return null;
      }),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    const sandbox = {
      exec: vi.fn().mockImplementation(async (command: string) => {
        events.push(command);
        return createMockExecResult();
      }),
      restoreBackup: vi.fn(),
    } as unknown as Sandbox;

    await expect(restoreIfNeeded(sandbox, bucket)).resolves.toBeUndefined();

    expect(events).toEqual([
      'umount /home/openclaw 2>/dev/null; true',
      'get:backup-handle.json',
      'get:backup-manifest.json',
    ]);
    expect(vi.mocked(sandbox.restoreBackup)).not.toHaveBeenCalled();
    expect(vi.mocked(bucket.delete)).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'legacy BACKUP_EXPIRED message', error: new Error('BACKUP_EXPIRED') },
    { label: 'legacy BACKUP_NOT_FOUND message', error: new Error('BACKUP_NOT_FOUND') },
    {
      label: 'SDK BackupExpiredError',
      error: Object.assign(
        new Error(
          'Backup 83a10969-7398-4f3c-b51c-f981e815ee56 has expired (created: 2026-08-27T21:49:50.948Z, TTL: 604800s). Create a new backup.',
        ),
        { name: 'BackupExpiredError', code: 'BACKUP_EXPIRED' },
      ),
    },
    {
      label: 'RPC-serialized BackupExpiredError',
      error: new Error(
        'BackupExpiredError: Backup 83a10969-7398-4f3c-b51c-f981e815ee56 has expired (created: 2026-08-27T21:49:50.948Z, TTL: 604800s). Create a new backup.',
      ),
    },
  ])(
    'clears a $label handle and pending restore marker, then marks this isolate restored',
    async ({ error }) => {
      clearPersistenceCache();
      const bucket = {
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key !== 'backup-handle.json') return null;
          return { etag: 'old-etag', json: vi.fn().mockResolvedValue(oldHandle) };
        }),
        put: vi.fn().mockResolvedValue({ etag: 'tombstone-etag' }),
        delete: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(null),
      } as unknown as R2Bucket;
      const sandbox = {
        exec: vi.fn().mockResolvedValue(createMockExecResult()),
        restoreBackup: vi.fn().mockRejectedValue(error),
      } as unknown as Sandbox;

      await expect(restoreIfNeeded(sandbox, bucket)).resolves.toBeUndefined();
      await expect(restoreIfNeeded(sandbox, bucket)).resolves.toBeUndefined();

      expect(vi.mocked(bucket.put)).toHaveBeenCalledWith('backup-handle.json', 'null', {
        onlyIf: { etagMatches: 'old-etag' },
      });
      expect(vi.mocked(bucket.delete)).toHaveBeenCalledWith('restore-needed');
      expect(vi.mocked(bucket.delete)).not.toHaveBeenCalledWith(
        expect.stringMatching(/^backups\//),
      );
      expect(vi.mocked(bucket.get)).toHaveBeenCalled();
    },
  );

  it('preserves the backup handle and restore marker for unrelated restore failures', async () => {
    clearPersistenceCache();
    const bucket = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key !== 'backup-handle.json') return null;
        return { etag: 'old-etag', json: vi.fn().mockResolvedValue(oldHandle) };
      }),
      put: vi.fn(),
      delete: vi.fn(),
      head: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;
    const failure = new Error('restore transport unavailable');
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi.fn().mockRejectedValue(failure),
    } as unknown as Sandbox;

    await expect(restoreIfNeeded(sandbox, bucket)).rejects.toBe(failure);
    expect(vi.mocked(bucket.put)).not.toHaveBeenCalled();
    expect(vi.mocked(bucket.delete)).not.toHaveBeenCalled();
  });
});

function inMemoryBucket(
  options: { failHandleWrites?: () => boolean; failManifestWrites?: () => boolean } = {},
) {
  const objects = new Map<
    string,
    { body: string; etag: string; size: number; uploaded: Date; json?: unknown }
  >();
  let n = 0;
  const bucket = {
    get: vi.fn().mockImplementation(async (key: string) => {
      const current = objects.get(key);
      if (!current) return null;
      return {
        etag: current.etag,
        uploaded: current.uploaded,
        size: current.size,
        json: async () => (current.json !== undefined ? current.json : JSON.parse(current.body)),
        text: async () => current.body,
      };
    }),
    head: vi.fn().mockImplementation(async (key: string) => {
      const current = objects.get(key);
      if (!current) return null;
      return { etag: current.etag, size: current.size, uploaded: current.uploaded, key };
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string, putOptions?: R2PutOptions) => {
      if (key === 'backup-handle.json' && options.failHandleWrites?.()) {
        throw new Error('handle store failed');
      }
      if (key === 'backup-manifest.json' && options.failManifestWrites?.()) {
        return null;
      }
      const current = objects.get(key);
      const onlyIf = putOptions?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagDoesNotMatch === '*' && current) return null;
      if (onlyIf?.etagMatches && onlyIf.etagMatches !== current?.etag) return null;
      n += 1;
      const body = typeof value === 'string' ? value : '';
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const stored = {
        body,
        etag: `e${n}`,
        size: body.length,
        uploaded: new Date(),
        json,
      };
      objects.set(key, stored);
      return { etag: stored.etag, size: stored.size, uploaded: stored.uploaded };
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      objects.delete(key);
    }),
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe('backup manifest and health', () => {
  it('imports a legacy handle as a migrated generation before Backup Now', async () => {
    const { bucket } = inMemoryBucket();
    await bucket.put(
      'backup-handle.json',
      JSON.stringify({ id: validBackupHandle.id, dir: '/home/openclaw' }),
    );
    await bucket.put(
      `backups/${validBackupHandle.id}/meta.json`,
      JSON.stringify({
        id: validBackupHandle.id,
        dir: '/home/openclaw',
        createdAt: new Date().toISOString(),
        ttl: 3600,
        sizeBytes: 123,
      }),
    );
    await bucket.put(`backups/${validBackupHandle.id}/data.sqsh`, 'archive');
    const data = await bucket.head(`backups/${validBackupHandle.id}/data.sqsh`);
    if (data) {
      // sizeBytes 123 vs body length mismatch is ok for migration visibility
    }

    const manifest = await reconcileBackupAuthority(bucket);
    expect(manifest.generations).toHaveLength(1);
    expect(manifest.generations[0]).toMatchObject({
      id: validBackupHandle.id,
      source: 'migrated',
      verification: 'legacy',
    });
    expect(manifest.currentId).toBe(validBackupHandle.id);
  });

  it('repairs the handle from the manifest after a handle-write failure', async () => {
    let failHandle = false;
    const { bucket, objects } = inMemoryBucket({ failHandleWrites: () => failHandle });
    await bucket.put(
      'backup-handle.json',
      JSON.stringify({ id: validBackupHandle.id, dir: '/home/openclaw' }),
    );
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      createBackup: vi.fn().mockImplementation(async () => {
        const id = '22222222-2222-4222-8222-222222222222';
        await bucket.put(
          `backups/${id}/meta.json`,
          JSON.stringify({
            id,
            dir: '/home/openclaw',
            createdAt: new Date().toISOString(),
            ttl: 3600,
            sizeBytes: 4,
          }),
        );
        await bucket.put(`backups/${id}/data.sqsh`, 'data');
        return { id, dir: '/home/openclaw' };
      }),
    } as unknown as Sandbox;

    failHandle = true;
    await expect(createSnapshot(sandbox, bucket)).resolves.toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      dir: '/home/openclaw',
    });
    expect(JSON.parse(objects.get('backup-handle.json')?.body ?? '{}').id).toBe(validBackupHandle.id);

    failHandle = false;
    const repaired = await withBackupOperationLease(bucket, async () =>
      reconcileBackupAuthority(bucket),
    );
    expect(repaired.currentId).toBe('22222222-2222-4222-8222-222222222222');
    expect(JSON.parse(objects.get('backup-handle.json')?.body ?? '{}').id).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('puts restore-needed when pendingRestoreId is set and the marker is missing', async () => {
    const { bucket } = inMemoryBucket();
    const pending = validBackupHandle.id;
    await bucket.put(
      'backup-manifest.json',
      JSON.stringify({
        version: 1,
        retention: 5,
        currentId: '22222222-2222-4222-8222-222222222222',
        pendingRestoreId: pending,
        lastLiveId: '22222222-2222-4222-8222-222222222222',
        lastSkipAt: null,
        lastError: null,
        lastRestoreOutcome: null,
        generations: [
          { id: pending, dir: '/home/openclaw', createdAt: new Date().toISOString(), ttl: 3600 },
        ],
      }),
    );

    await reconcileBackupAuthority(bucket);
    expect(await bucket.head('restore-needed')).toBeTruthy();
    expect((await bucket.get('backup-handle.json'))?.json).toBeDefined();
    await expect((await bucket.get('backup-handle.json'))!.json()).resolves.toEqual({
      id: pending,
      dir: '/home/openclaw',
    });
  });
});

describe('classifyBackupHealth', () => {
  it('reports none when no handle exists', async () => {
    const { bucket } = inMemoryBucket();
    await expect(classifyBackupHealth(bucket, null)).resolves.toBe('none');
  });

  it('classifies an invalid UUID handle as corrupt', async () => {
    await expect(
      classifyBackupHealth(preflightBucket(), { id: 'not-a-uuid', dir: '/home/openclaw' }),
    ).resolves.toBe('corrupt');
  });

  it('classifies malformed metadata as corrupt', async () => {
    await expect(
      classifyBackupHealth(preflightBucket({ malformedMetadata: true }), validBackupHandle),
    ).resolves.toBe('corrupt');
  });

  it('classifies expired metadata as expired', async () => {
    await expect(
      classifyBackupHealth(
        preflightBucket({
          metadata: {
            id: validBackupHandle.id,
            dir: validBackupHandle.dir,
            createdAt: new Date(Date.now() - 61_000).toISOString(),
            ttl: 1,
            sizeBytes: 123,
          },
        }),
        validBackupHandle,
      ),
    ).resolves.toBe('expired');
  });

  it('classifies an empty archive as missing', async () => {
    await expect(
      classifyBackupHealth(preflightBucket({ dataSize: 0 }), validBackupHandle),
    ).resolves.toBe('missing');
  });

  it('classifies a complete backup with remaining TTL above 48h as valid', async () => {
    const bucket = preflightBucket({
      metadata: {
        id: validBackupHandle.id,
        dir: validBackupHandle.dir,
        createdAt: new Date().toISOString(),
        ttl: 604800,
        sizeBytes: 123,
      },
    });
    await expect(classifyBackupHealth(bucket, validBackupHandle)).resolves.toBe('valid');
  });

  it('classifies a restorable backup inside 48h remaining as near-expiry', async () => {
    const bucket = preflightBucket({
      metadata: {
        id: validBackupHandle.id,
        dir: validBackupHandle.dir,
        createdAt: new Date().toISOString(),
        ttl: 3600,
        sizeBytes: 123,
      },
    });
    await expect(classifyBackupHealth(bucket, validBackupHandle)).resolves.toBe('near-expiry');
  });
});

describe('restore reservation and manifest authority', () => {
  const pending = validBackupHandle;
  const live = { id: '22222222-2222-4222-8222-222222222222', dir: '/home/openclaw' };

  async function seedRestorable(bucket: R2Bucket, generation: { id: string; dir: string }, size = 4) {
    await bucket.put(
      `backups/${generation.id}/meta.json`,
      JSON.stringify({
        id: generation.id,
        dir: generation.dir,
        createdAt: new Date().toISOString(),
        ttl: 604800,
        sizeBytes: size,
      }),
    );
    await bucket.put(`backups/${generation.id}/data.sqsh`, 'data');
  }

  it('restores the pending generation instead of a lagging handle', async () => {
    clearPersistenceCache();
    const { bucket } = inMemoryBucket();
    await seedRestorable(bucket, pending);
    await seedRestorable(bucket, live);
    await bucket.put(
      'backup-manifest.json',
      JSON.stringify({
        version: 1,
        retention: 5,
        currentId: live.id,
        pendingRestoreId: pending.id,
        lastLiveId: live.id,
        lastSkipAt: null,
        lastError: null,
        lastRestoreOutcome: null,
        generations: [
          { id: pending.id, dir: pending.dir, createdAt: new Date().toISOString(), ttl: 604800 },
          { id: live.id, dir: live.dir, createdAt: new Date().toISOString(), ttl: 604800 },
        ],
      }),
    );
    await bucket.put('backup-handle.json', JSON.stringify(live));
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;

    await restoreIfNeeded(sandbox, bucket);

    expect(vi.mocked(sandbox.restoreBackup)).toHaveBeenCalledWith(pending);
    const status = await getBackupStatus(bucket);
    expect(status.pendingRestoreId).toBeNull();
    expect(status.lastRestoreOutcome?.kind).toBe('restored');
  });

  it('keeps restore-needed when restore completion cannot CAS the manifest', async () => {
    clearPersistenceCache();
    let failManifest = false;
    const { bucket } = inMemoryBucket({ failManifestWrites: () => failManifest });
    await seedRestorable(bucket, pending);
    await bucket.put('backup-handle.json', JSON.stringify(pending));
    await bucket.put('restore-needed', '1');
    failManifest = true;
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;

    await expect(restoreIfNeeded(sandbox, bucket)).rejects.toThrow('completing restore');
    expect(await bucket.head('restore-needed')).toBeTruthy();
  });

  it('repairs a corrupt manifest instead of treating it as missing', async () => {
    const { bucket } = inMemoryBucket();
    await bucket.put('backup-manifest.json', JSON.stringify({ version: 2 }));
    await bucket.put('backup-handle.json', JSON.stringify(pending));
    await seedRestorable(bucket, pending);

    const manifest = await reconcileBackupAuthority(bucket);
    expect(manifest.lastError?.code).toBe('corrupt-manifest');
    expect(manifest.generations[0]?.id).toBe(pending.id);
    const status = await getBackupStatus(bucket);
    expect(status.generations).toHaveLength(1);
  });

  it('reserves restore then cancel returns the live handle', async () => {
    const { bucket, objects } = inMemoryBucket();
    await seedRestorable(bucket, pending);
    await seedRestorable(bucket, live);
    await bucket.put('backup-handle.json', JSON.stringify(live));
    await reconcileBackupAuthority(bucket);
    await bucket.put(
      'backup-manifest.json',
      JSON.stringify({
        version: 1,
        retention: 5,
        currentId: live.id,
        pendingRestoreId: null,
        lastLiveId: live.id,
        lastSkipAt: null,
        lastError: null,
        lastRestoreOutcome: null,
        generations: [
          {
            id: pending.id,
            dir: pending.dir,
            createdAt: new Date().toISOString(),
            ttl: 604800,
            sizeBytes: 4,
            archiveEtag: objects.get(`backups/${pending.id}/data.sqsh`)?.etag ?? null,
            source: 'manual',
            verification: 'stored-etag',
          },
          {
            id: live.id,
            dir: live.dir,
            createdAt: new Date().toISOString(),
            ttl: 604800,
            sizeBytes: 4,
            archiveEtag: objects.get(`backups/${live.id}/data.sqsh`)?.etag ?? null,
            source: 'manual',
            verification: 'stored-etag',
          },
        ],
      }),
    );

    await reserveRestore(bucket, pending.id);
    expect(JSON.parse(objects.get('backup-handle.json')?.body ?? '{}').id).toBe(pending.id);
    expect(await bucket.head('restore-needed')).toBeTruthy();

    await cancelRestoreReservation(bucket);
    expect(JSON.parse(objects.get('backup-handle.json')?.body ?? '{}').id).toBe(live.id);
    expect(await bucket.head('restore-needed')).toBeNull();
  });

  it('rejects out-of-range retention', async () => {
    const { bucket } = inMemoryBucket();
    await expect(setBackupRetention(bucket, 100)).rejects.toThrow('integer from 3 to 20');
    await expect(setBackupRetention(bucket, 5.5)).rejects.toThrow('integer from 3 to 20');
  });

  it('self-heals a corrupt manifest on getBackupStatus without an explicit reconcile', async () => {
    const { bucket } = inMemoryBucket();
    await seedRestorable(bucket, pending);
    await bucket.put('backup-handle.json', JSON.stringify(pending));
    await bucket.put('backup-manifest.json', JSON.stringify({ version: 2 }));

    const status = await getBackupStatus(bucket);

    expect(status.lastError?.code).toBe('corrupt-manifest');
    expect(status.generations.some((row) => row.id === pending.id)).toBe(true);
    const repaired = JSON.parse(
      (await (await bucket.get('backup-manifest.json'))!.text()) as string,
    );
    expect(repaired.generations[0]?.id).toBe(pending.id);
  });

  it('self-heals a corrupt manifest on restoreIfNeeded without an explicit reconcile', async () => {
    clearPersistenceCache();
    const { bucket } = inMemoryBucket();
    await seedRestorable(bucket, pending);
    await bucket.put('backup-handle.json', JSON.stringify(pending));
    await bucket.put('backup-manifest.json', JSON.stringify({ version: 2 }));
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;

    await restoreIfNeeded(sandbox, bucket);

    expect(vi.mocked(sandbox.restoreBackup)).toHaveBeenCalledWith(pending);
    const status = await getBackupStatus(bucket);
    expect(status.lastRestoreOutcome?.kind).toBe('restored');
    expect(status.generations.some((row) => row.id === pending.id)).toBe(true);
  });

  it('does not clear a newer restore reservation when completing an in-flight restore', async () => {
    clearPersistenceCache();
    const { bucket, objects } = inMemoryBucket();
    await seedRestorable(bucket, pending);
    await seedRestorable(bucket, live);
    await bucket.put('backup-handle.json', JSON.stringify(pending));
    await bucket.put(
      'backup-manifest.json',
      JSON.stringify({
        version: 1,
        retention: 5,
        currentId: pending.id,
        pendingRestoreId: pending.id,
        lastLiveId: live.id,
        lastSkipAt: null,
        lastError: null,
        lastRestoreOutcome: null,
        generations: [
          {
            id: pending.id,
            dir: pending.dir,
            createdAt: new Date().toISOString(),
            ttl: 604800,
            sizeBytes: 4,
            archiveEtag: objects.get(`backups/${pending.id}/data.sqsh`)?.etag ?? null,
            source: 'manual',
            verification: 'stored-etag',
          },
          {
            id: live.id,
            dir: live.dir,
            createdAt: new Date().toISOString(),
            ttl: 604800,
            sizeBytes: 4,
            archiveEtag: objects.get(`backups/${live.id}/data.sqsh`)?.etag ?? null,
            source: 'manual',
            verification: 'stored-etag',
          },
        ],
      }),
    );
    await bucket.put('restore-needed', '1');

    let releaseRestore: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      /* started when restoreBackup is entered */
      void resolve;
    });
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const sandbox = {
      exec: vi.fn().mockResolvedValue(createMockExecResult()),
      restoreBackup: vi.fn().mockImplementation(async () => {
        signalStarted?.();
        await new Promise<void>((wait) => {
          releaseRestore = wait;
        });
      }),
    } as unknown as Sandbox;
    void restoreStarted;

    const restoring = restoreIfNeeded(sandbox, bucket);
    await started;
    await reserveRestore(bucket, live.id);
    releaseRestore?.();
    await restoring;

    expect(JSON.parse(objects.get('backup-manifest.json')?.body ?? '{}').pendingRestoreId).toBe(
      live.id,
    );
    expect(JSON.parse(objects.get('backup-handle.json')?.body ?? '{}').id).toBe(live.id);
    expect(await bucket.head('restore-needed')).toBeTruthy();
  });

  it('does not delete pruned archives when the kept manifest CAS fails', async () => {
    let failManifest = false;
    const { bucket, objects } = inMemoryBucket({ failManifestWrites: () => failManifest });
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    const generations = [];
    for (const [index, id] of ids.entries()) {
      const generation = { id, dir: '/home/openclaw' };
      await seedRestorable(bucket, generation);
      generations.push({
        id,
        dir: '/home/openclaw',
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
        ttl: 604800,
        sizeBytes: 4,
        archiveEtag: objects.get(`backups/${id}/data.sqsh`)?.etag ?? null,
        source: 'manual',
        verification: 'stored-etag',
      });
    }
    await bucket.put('backup-handle.json', JSON.stringify({ id: ids[0], dir: '/home/openclaw' }));
    await bucket.put(
      'backup-manifest.json',
      JSON.stringify({
        version: 1,
        retention: 5,
        currentId: ids[0],
        pendingRestoreId: null,
        lastLiveId: ids[0],
        lastSkipAt: null,
        lastError: null,
        lastRestoreOutcome: null,
        generations,
      }),
    );
    failManifest = true;
    await expect(setBackupRetention(bucket, 3)).rejects.toThrow('Backup manifest CAS failed');
    expect(objects.has(`backups/${ids[3]}/data.sqsh`)).toBe(true);
    expect(objects.has(`backups/${ids[3]}/meta.json`)).toBe(true);
  });
});
