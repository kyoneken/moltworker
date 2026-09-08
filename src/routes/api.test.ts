import { describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../test-utils';
import { api } from './api';

describe('GET /api/admin/storage', () => {
  it('reports the stored backup ID and the backup-handle upload time', async () => {
    const backupBucket = {
      get: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id: 'backup-123', dir: '/home/openclaw' }),
      }),
      head: vi.fn().mockResolvedValue({
        key: 'backup-handle.json',
        version: 'version-1',
        size: 42,
        etag: 'etag-1',
        httpEtag: '"etag-1"',
        checksums: {},
        uploaded: new Date('2026-08-22T11:53:56.000Z'),
        storageClass: 'Standard',
        writeHttpMetadata: vi.fn(),
      }),
    } as unknown as R2Bucket;

    const response = await api.request(
      '/admin/storage',
      { method: 'GET' },
      createMockEnv({ DEV_MODE: 'true', BACKUP_BUCKET: backupBucket }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      lastBackupId: 'backup-123',
      lastSync: '2026-08-22T11:53:56.000Z',
    });
  });
});

describe('PUT /api/admin/storage/retention', () => {
  it('rejects values outside 3-20 without writing', async () => {
    const put = vi.fn();
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
      head: vi.fn().mockResolvedValue(null),
      put,
    } as unknown as R2Bucket;

    const response = await api.request(
      '/admin/storage/retention',
      { method: 'PUT', body: JSON.stringify({ retention: 100 }) },
      createMockEnv({ DEV_MODE: 'true', BACKUP_BUCKET: bucket }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'retention must be an integer from 3 to 20' });
    expect(put.mock.calls.filter(([key]) => key === 'backup-manifest.json')).toHaveLength(0);
  });
});
