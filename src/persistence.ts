import type { Sandbox } from '@cloudflare/sandbox';

const BACKUP_DIR = '/home/openclaw';
const HANDLE_KEY = 'backup-handle.json';
const MANIFEST_KEY = 'backup-manifest.json';
const BACKUP_EXPIRY_BUFFER_MS = 60_000;
export const SNAPSHOT_TTL_SECONDS = 604800;
export const DEFAULT_RETENTION = 5;
export const MIN_RETENTION = 3;
export const MAX_RETENTION = 20;
export const NEAR_EXPIRY_MS = 48 * 60 * 60 * 1000;
const BACKUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKUP_OPERATION_LEASE_KEY = 'backup-operation-lock';
const BACKUP_OPERATION_LEASE_MS = 240_000;
const BACKUP_OPERATION_HEARTBEAT_MS = 30_000;
const BACKUP_OPERATION_WAIT_MS = 100;
const BACKUP_OPERATION_TIMEOUT_MS = 10_000;

const RESTORE_NEEDED_KEY = 'restore-needed';

export type BackupHealth = 'valid' | 'near-expiry' | 'expired' | 'missing' | 'corrupt' | 'none';
export type BackupSource = 'manual' | 'cron' | 'migrated';
export type BackupVerification = 'stored-etag' | 'legacy';
export type RestoreOutcomeKind = 'restored' | 'expired-continue' | 'missing-continue';

export interface BackupGeneration {
  id: string;
  dir: string;
  createdAt: string;
  ttl: number;
  sizeBytes: number;
  archiveEtag: string | null;
  source: BackupSource;
  verification: BackupVerification;
  fingerprint?: string;
}

export interface RestoreOutcome {
  at: string;
  kind: RestoreOutcomeKind;
  backupId?: string;
}

export interface BackupManifest {
  version: 1;
  retention: number;
  currentId: string | null;
  pendingRestoreId: string | null;
  lastLiveId: string | null;
  lastSkipAt: string | null;
  lastError: { at: string; code: string } | null;
  lastRestoreOutcome: RestoreOutcome | null;
  generations: BackupGeneration[];
}

// Per-isolate flag for fast path (avoid R2 read on every request)
let restored = false;

function emptyManifest(): BackupManifest {
  return {
    version: 1,
    retention: DEFAULT_RETENTION,
    currentId: null,
    pendingRestoreId: null,
    lastLiveId: null,
    lastSkipAt: null,
    lastError: null,
    lastRestoreOutcome: null,
    generations: [],
  };
}

function clampRetention(value: number): number {
  if (!Number.isInteger(value)) return DEFAULT_RETENTION;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, value));
}

function authorityHandleId(manifest: BackupManifest): string | null {
  return manifest.pendingRestoreId ?? manifest.currentId;
}

function protectedGenerationIds(manifest: BackupManifest): Set<string> {
  return new Set(
    [manifest.currentId, manifest.pendingRestoreId, manifest.lastLiveId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
}

interface HeldBackupOperationLease {
  owner: string;
  etag: string;
  expiresAt: number;
}

export class BackupOperationLeaseTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the backup operation lease');
  }
}

class BackupOperationLeaseLostError extends Error {
  constructor() {
    super('Backup operation lease ownership was lost');
  }
}

export interface BackupOperationLease {
  renew(): Promise<void>;
}

function leaseExpiresAt(object: R2Object): number {
  const expiresAt = Number(object.customMetadata?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0;
}

function sleepForLease(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireBackupOperationLease(bucket: R2Bucket): Promise<HeldBackupOperationLease> {
  const deadline = Date.now() + BACKUP_OPERATION_TIMEOUT_MS;
  /* eslint-disable no-await-in-loop -- bounded R2 CAS polling is intentional */
  while (Date.now() < deadline) {
    const current = await bucket.head(BACKUP_OPERATION_LEASE_KEY);
    if (Date.now() >= deadline) break;
    if (current && leaseExpiresAt(current) > Date.now()) {
      await sleepForLease(Math.min(BACKUP_OPERATION_WAIT_MS, deadline - Date.now()));
      continue;
    }
    const owner = crypto.randomUUID();
    const expiresAt = Date.now() + BACKUP_OPERATION_LEASE_MS;
    const acquired = await bucket.put(BACKUP_OPERATION_LEASE_KEY, '', {
      customMetadata: { owner, expiresAt: String(expiresAt) },
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
    });
    if (acquired) {
      const lease = { owner, etag: acquired.etag, expiresAt };
      if (Date.now() >= deadline) {
        await releaseBackupOperationLease(bucket, lease);
        throw new BackupOperationLeaseTimeoutError();
      }
      return lease;
    }
    await sleepForLease(Math.min(BACKUP_OPERATION_WAIT_MS, deadline - Date.now()));
  }
  /* eslint-enable no-await-in-loop */
  throw new BackupOperationLeaseTimeoutError();
}

class BackupOperationLeaseKeeper implements BackupOperationLease {
  private current: HeldBackupOperationLease;
  private stopped = false;
  private heartbeat: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private renewalTail: Promise<void> = Promise.resolve();
  private fatalError: Error | null = null;

  constructor(
    private readonly bucket: R2Bucket,
    lease: HeldBackupOperationLease,
  ) {
    this.current = lease;
  }

  start(): void {
    this.heartbeat = this.runHeartbeat();
  }

  async renew(): Promise<void> {
    if (this.fatalError) throw this.fatalError;
    await this.enqueueRenewal(true);
    if (this.fatalError) throw this.fatalError;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.heartbeat;
    await this.renewalTail;
  }

  get lease(): HeldBackupOperationLease {
    return this.current;
  }

  private async runHeartbeat(): Promise<void> {
    /* eslint-disable no-await-in-loop -- a single owner renews one lease serially */
    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BACKUP_OPERATION_HEARTBEAT_MS);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      if (this.stopped) break;
      try {
        await this.enqueueRenewal(false);
      } catch {
        // Retry transient heartbeat failures before the locally-held lease expires.
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  private async enqueueRenewal(required: boolean): Promise<void> {
    const renewal = this.renewalTail.then(async () => {
      if (this.fatalError) throw this.fatalError;
      const expiresAt = Date.now() + BACKUP_OPERATION_LEASE_MS;
      try {
        const renewed = await this.bucket.put(BACKUP_OPERATION_LEASE_KEY, '', {
          customMetadata: { owner: this.current.owner, expiresAt: String(expiresAt) },
          onlyIf: { etagMatches: this.current.etag },
        });
        if (!renewed) throw new BackupOperationLeaseLostError();
        this.current = { owner: this.current.owner, etag: renewed.etag, expiresAt };
      } catch (error) {
        if (
          error instanceof BackupOperationLeaseLostError ||
          required ||
          Date.now() >= this.current.expiresAt
        ) {
          this.fatalError = error instanceof Error ? error : new Error(String(error));
          throw this.fatalError;
        }
        console.warn('[persistence] Transient backup operation lease renewal failed; will retry');
      }
    });
    this.renewalTail = renewal.catch(() => undefined);
    return renewal;
  }
}

async function releaseBackupOperationLease(
  bucket: R2Bucket,
  lease: HeldBackupOperationLease,
): Promise<void> {
  try {
    await bucket.put(BACKUP_OPERATION_LEASE_KEY, '', {
      customMetadata: { owner: lease.owner, expiresAt: '0' },
      onlyIf: { etagMatches: lease.etag },
    });
  } catch (error) {
    console.warn('[persistence] Failed to release backup operation lease:', error);
  }
}

export async function withBackupOperationLease<T>(
  bucket: R2Bucket,
  operation: (lease: BackupOperationLease) => Promise<T>,
): Promise<T> {
  const keeper = new BackupOperationLeaseKeeper(bucket, await acquireBackupOperationLease(bucket));
  keeper.start();
  try {
    return await operation(keeper);
  } finally {
    await keeper.stop();
    await releaseBackupOperationLease(bucket, keeper.lease);
  }
}

/**
 * Signal that a restore is needed after a gateway restart. A cold container
 * with no canonical config consumes this marker when it restores. A live
 * container's config deliberately wins over an older snapshot, so it leaves
 * the marker pending for a future cold restoration.
 */
export async function signalRestoreNeeded(bucket: R2Bucket): Promise<void> {
  restored = false;
  await bucket.put(RESTORE_NEEDED_KEY, '1');
}

// Backward compat alias
export function clearPersistenceCache(): void {
  restored = false;
}

async function getStoredHandleWithEtag(
  bucket: R2Bucket,
): Promise<{ handle: { id: string; dir: string }; etag: string } | null> {
  const obj = await bucket.get(HANDLE_KEY);
  if (!obj) return null;
  try {
    const value: unknown = await obj.json();
    if (!value || typeof value !== 'object') return null;
    const handle = value as { id?: unknown; dir?: unknown };
    if (typeof handle.id !== 'string' || typeof handle.dir !== 'string') return null;
    return { handle: { id: handle.id, dir: handle.dir }, etag: obj.etag };
  } catch {
    return null;
  }
}

async function getStoredHandle(bucket: R2Bucket): Promise<{ id: string; dir: string } | null> {
  return (await getStoredHandleWithEtag(bucket))?.handle ?? null;
}

function isBackupHandle(value: unknown): value is { id: string; dir: string } {
  if (!value || typeof value !== 'object') return false;
  const handle = value as { id?: unknown; dir?: unknown };
  return (
    typeof handle.id === 'string' &&
    BACKUP_ID_PATTERN.test(handle.id) &&
    typeof handle.dir === 'string' &&
    handle.dir === BACKUP_DIR
  );
}

function parseManifest(value: unknown): BackupManifest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<BackupManifest>;
  if (raw.version !== 1 || !Array.isArray(raw.generations)) return null;
  return {
    version: 1,
    retention: clampRetention(typeof raw.retention === 'number' ? raw.retention : DEFAULT_RETENTION),
    currentId: typeof raw.currentId === 'string' ? raw.currentId : null,
    pendingRestoreId: typeof raw.pendingRestoreId === 'string' ? raw.pendingRestoreId : null,
    lastLiveId: typeof raw.lastLiveId === 'string' ? raw.lastLiveId : null,
    lastSkipAt: typeof raw.lastSkipAt === 'string' ? raw.lastSkipAt : null,
    lastError:
      raw.lastError && typeof raw.lastError === 'object' && typeof raw.lastError.code === 'string'
        ? { at: String(raw.lastError.at ?? ''), code: raw.lastError.code }
        : null,
    lastRestoreOutcome:
      raw.lastRestoreOutcome &&
      typeof raw.lastRestoreOutcome === 'object' &&
      typeof raw.lastRestoreOutcome.kind === 'string'
        ? {
            at: String(raw.lastRestoreOutcome.at ?? ''),
            kind: raw.lastRestoreOutcome.kind,
            backupId: raw.lastRestoreOutcome.backupId,
          }
        : null,
    generations: raw.generations.filter(
      (generation): generation is BackupGeneration =>
        !!generation &&
        typeof generation.id === 'string' &&
        typeof generation.dir === 'string' &&
        typeof generation.createdAt === 'string' &&
        typeof generation.ttl === 'number',
    ),
  };
}

type ManifestRead =
  | { status: 'missing' }
  | { status: 'corrupt'; etag: string }
  | { status: 'ok'; manifest: BackupManifest; etag: string };

async function readManifest(bucket: R2Bucket): Promise<ManifestRead> {
  const obj = await bucket.get(MANIFEST_KEY);
  if (!obj) return { status: 'missing' };
  try {
    const manifest = parseManifest(await obj.json());
    if (!manifest) return { status: 'corrupt', etag: obj.etag };
    return { status: 'ok', manifest, etag: obj.etag };
  } catch {
    return { status: 'corrupt', etag: obj.etag };
  }
}

async function getManifestWithEtag(
  bucket: R2Bucket,
): Promise<{ manifest: BackupManifest; etag: string } | null> {
  const read = await readManifest(bucket);
  if (read.status !== 'ok') return null;
  return { manifest: read.manifest, etag: read.etag };
}

async function commitManifestUpdate(
  bucket: R2Bucket,
  update: (current: BackupManifest) => BackupManifest,
): Promise<boolean> {
  /* eslint-disable no-await-in-loop -- bounded manifest CAS retries */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readManifest(bucket);
    const current = read.status === 'ok' ? read.manifest : emptyManifest();
    const etag = read.status === 'missing' ? null : read.etag;
    const next = update(current);
    if (read.status === 'ok' && JSON.stringify(next) === JSON.stringify(current)) {
      return true;
    }
    const written = await putManifest(bucket, next, etag);
    if (written) return true;
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

async function putManifest(
  bucket: R2Bucket,
  manifest: BackupManifest,
  etag: string | null,
): Promise<R2Object | null> {
  return bucket.put(MANIFEST_KEY, JSON.stringify(manifest), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  });
}

async function putHandleConditional(
  bucket: R2Bucket,
  handle: { id: string; dir: string },
  etag: string | null,
): Promise<R2Object | null> {
  return bucket.put(HANDLE_KEY, JSON.stringify(handle), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  });
}

function remainingTtlMs(createdAt: string, ttl: number, nowMs: number): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(ttl) || ttl <= 0) return 0;
  return created + ttl * 1000 - BACKUP_EXPIRY_BUFFER_MS - nowMs;
}

export async function classifyBackupHealth(
  bucket: R2Bucket,
  handle: { id: string; dir: string } | null,
  storedEtag: string | null = null,
  nowMs: number = Date.now(),
): Promise<BackupHealth> {
  if (!handle) return 'none';
  if (!isBackupHandle(handle)) return 'corrupt';

  try {
    const metadataObject = await bucket.get(`backups/${handle.id}/meta.json`);
    if (!metadataObject) return 'missing';
    const metadata: unknown = await metadataObject.json();
    if (!metadata || typeof metadata !== 'object') return 'corrupt';
    const meta = metadata as {
      id?: unknown;
      dir?: unknown;
      createdAt?: unknown;
      ttl?: unknown;
      sizeBytes?: unknown;
    };
    if (
      meta.id !== handle.id ||
      meta.dir !== handle.dir ||
      typeof meta.createdAt !== 'string' ||
      typeof meta.ttl !== 'number' ||
      !Number.isFinite(meta.ttl) ||
      meta.ttl <= 0 ||
      typeof meta.sizeBytes !== 'number' ||
      !Number.isFinite(meta.sizeBytes) ||
      meta.sizeBytes <= 0
    ) {
      return 'corrupt';
    }

    const remaining = remainingTtlMs(meta.createdAt, meta.ttl, nowMs);
    if (remaining <= 0) return 'expired';

    const backupData = await bucket.head(`backups/${handle.id}/data.sqsh`);
    if (!backupData || !Number.isFinite(backupData.size) || backupData.size <= 0) {
      return 'missing';
    }
    if (backupData.size !== meta.sizeBytes) return 'corrupt';
    if (storedEtag && backupData.etag && backupData.etag !== storedEtag) return 'corrupt';
    if (remaining <= NEAR_EXPIRY_MS) return 'near-expiry';
    return 'valid';
  } catch {
    return 'corrupt';
  }
}

async function ensureRestoreMarker(bucket: R2Bucket, needed: boolean): Promise<void> {
  const marker = await bucket.head(RESTORE_NEEDED_KEY);
  if (needed && !marker) {
    await bucket.put(RESTORE_NEEDED_KEY, '1');
  }
}

/**
 * Load or migrate the manifest, then make handle and restore-needed match it.
 * Manifest is the commit log; handle/marker lag is repaired forward.
 */
function migratedGeneration(handle: { id: string; dir: string }): BackupGeneration {
  return {
    id: handle.id,
    dir: handle.dir,
    createdAt: new Date().toISOString(),
    ttl: SNAPSHOT_TTL_SECONDS,
    sizeBytes: 0,
    archiveEtag: null,
    source: 'migrated',
    verification: 'legacy',
  };
}

async function hydrateMigratedGeneration(
  bucket: R2Bucket,
  generation: BackupGeneration,
): Promise<BackupGeneration> {
  const data = await bucket.head(`backups/${generation.id}/data.sqsh`);
  if (data && Number.isFinite(data.size) && data.size > 0) {
    generation.sizeBytes = data.size;
    if (data.etag) generation.archiveEtag = data.etag;
  }
  return generation;
}

export async function reconcileBackupAuthority(bucket: R2Bucket): Promise<BackupManifest> {
  const storedHandle = await getStoredHandleWithEtag(bucket);
  const read = await readManifest(bucket);
  let manifest = emptyManifest();

  if (read.status === 'ok') {
    manifest = read.manifest;
  } else if (storedHandle && isBackupHandle(storedHandle.handle)) {
    const generation = await hydrateMigratedGeneration(
      bucket,
      migratedGeneration(storedHandle.handle),
    );
    manifest = {
      ...emptyManifest(),
      currentId: storedHandle.handle.id,
      lastLiveId: storedHandle.handle.id,
      lastError:
        read.status === 'corrupt'
          ? { at: new Date().toISOString(), code: 'corrupt-manifest' }
          : null,
      generations: [generation],
    };
    await putManifest(bucket, manifest, read.status === 'corrupt' ? read.etag : null);
  } else if (read.status === 'corrupt') {
    manifest = {
      ...emptyManifest(),
      lastError: { at: new Date().toISOString(), code: 'corrupt-manifest' },
    };
    await putManifest(bucket, manifest, read.etag);
  }

  const targetId = authorityHandleId(manifest);
  if (targetId) {
    const generation = manifest.generations.find((row) => row.id === targetId);
    const desired = { id: targetId, dir: generation?.dir ?? BACKUP_DIR };
    const currentId = storedHandle?.handle.id;
    if (currentId !== desired.id) {
      await putHandleConditional(bucket, desired, storedHandle?.etag ?? null);
    }
  }

  await ensureRestoreMarker(bucket, manifest.pendingRestoreId !== null);
  return manifest;
}

/**
 * Confirm that a complete persisted Sandbox backup exists before a deliberate
 * container recreation. The SDK owns these backup object keys; this check is
 * read-only and never deletes or modifies backup data.
 */
export async function hasUsableBackup(bucket: R2Bucket): Promise<boolean> {
  try {
    const read = await readManifest(bucket);
    const storedHandle = await getStoredHandle(bucket);
    const targetId =
      read.status === 'ok' ? authorityHandleId(read.manifest) : storedHandle?.id ?? null;
    if (!targetId) return false;

    const generation =
      read.status === 'ok' ? read.manifest.generations.find((row) => row.id === targetId) : undefined;
    const handle = {
      id: targetId,
      dir: generation?.dir ?? storedHandle?.dir ?? BACKUP_DIR,
    };
    if (!isBackupHandle(handle)) return false;

    const health = await classifyBackupHealth(
      bucket,
      handle,
      generation?.verification === 'stored-etag' ? generation.archiveEtag : null,
    );
    return health === 'valid' || health === 'near-expiry';
  } catch {
    return false;
  }
}

async function storeHandle(bucket: R2Bucket, handle: { id: string; dir: string }): Promise<void> {
  await bucket.put(HANDLE_KEY, JSON.stringify(handle));
}

async function deleteBackupObjectsBestEffort(
  bucket: R2Bucket,
  handle: { id: string; dir: string },
  reason: string,
): Promise<void> {
  const results = await Promise.allSettled([
    bucket.delete(`backups/${handle.id}/data.sqsh`),
    bucket.delete(`backups/${handle.id}/meta.json`),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[persistence] Failed to clean ${reason} backup ${handle.id}:`, result.reason);
    }
  }
}

function partitionUnprotectedGenerations(manifest: BackupManifest): {
  kept: BackupGeneration[];
  removed: BackupGeneration[];
} {
  const protectedIds = protectedGenerationIds(manifest);
  const kept: BackupGeneration[] = [];
  const removed: BackupGeneration[] = [];
  for (const generation of manifest.generations) {
    if (protectedIds.has(generation.id) || kept.length < manifest.retention) {
      kept.push(generation);
    } else {
      removed.push(generation);
    }
  }
  return { kept, removed };
}

async function commitPrune(
  bucket: R2Bucket,
  manifest: BackupManifest,
): Promise<BackupManifest> {
  const { kept, removed } = partitionUnprotectedGenerations(manifest);
  const pruned = { ...manifest, generations: kept };
  const stored = await getManifestWithEtag(bucket);
  const committed = await putManifest(bucket, pruned, stored?.etag ?? null);
  if (!committed) throw new Error('Backup manifest CAS failed');
  await Promise.all(
    removed.map((generation) => deleteBackupObjectsBestEffort(bucket, generation, 'pruned')),
  );
  return pruned;
}

async function readCreatedBackupDetails(
  bucket: R2Bucket,
  handle: { id: string; dir: string },
): Promise<Pick<BackupGeneration, 'createdAt' | 'ttl' | 'sizeBytes' | 'archiveEtag'>> {
  const now = new Date().toISOString();
  try {
    const metadataObject = await bucket.get(`backups/${handle.id}/meta.json`);
    const metadata = metadataObject ? ((await metadataObject.json()) as Record<string, unknown>) : null;
    const data = await bucket.head(`backups/${handle.id}/data.sqsh`);
    const createdAt = typeof metadata?.createdAt === 'string' ? metadata.createdAt : now;
    const ttl = typeof metadata?.ttl === 'number' ? metadata.ttl : SNAPSHOT_TTL_SECONDS;
    const sizeBytes =
      typeof metadata?.sizeBytes === 'number' && metadata.sizeBytes > 0
        ? metadata.sizeBytes
        : (data?.size ?? 0);
    return {
      createdAt,
      ttl,
      sizeBytes,
      archiveEtag: data?.etag ?? null,
    };
  } catch {
    return { createdAt: now, ttl: SNAPSHOT_TTL_SECONDS, sizeBytes: 0, archiveEtag: null };
  }
}

/**
 * Restore the most recent backup if one exists and hasn't been restored yet.
 *
 * Gateway preparation calls this only when a stopped container has no
 * canonical config. A snapshot records the current directory state, including
 * the restored overlay's writable changes, so preparation must complete before
 * a snapshot is taken.
 *
 * The backup handle is read from R2 (persisted across Worker isolate restarts).
 * An in-memory flag prevents redundant restores within the same isolate.
 */
export async function restoreIfNeeded(sandbox: Sandbox, bucket: R2Bucket): Promise<void> {
  if (restored) {
    // Fast path: this isolate already restored. But check if another
    // isolate signaled a restore is needed (e.g. after gateway restart).
    const marker = await bucket.head(RESTORE_NEEDED_KEY);
    if (!marker) return; // No restore signal — we're good
    console.log('[persistence] Restore signal found in R2, re-restoring...');
    restored = false;
  }

  // Unmount any stale/disconnected overlay before inspecting the handle.
  // This also repairs a cold unhealthy container when no backup exists.
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    // May not be mounted
  }

  let storedHandle = await getStoredHandleWithEtag(bucket);
  let manifestRead = await readManifest(bucket);
  if (manifestRead.status === 'corrupt') {
    await reconcileBackupAuthority(bucket);
    storedHandle = await getStoredHandleWithEtag(bucket);
    manifestRead = await readManifest(bucket);
  }
  let handle = storedHandle?.handle ?? null;
  if (manifestRead.status === 'ok') {
    const targetId = authorityHandleId(manifestRead.manifest);
    if (!targetId) {
      handle = null;
    } else {
      const generation = manifestRead.manifest.generations.find((row) => row.id === targetId);
      handle = { id: targetId, dir: generation?.dir ?? BACKUP_DIR };
    }
  }
  if (!handle) {
    console.log('[persistence] No backup handle found in R2, skipping restore');
    restored = true;
    return;
  }

  console.log(`[persistence] Restoring backup ${handle.id}...`);
  const t0 = Date.now();
  try {
    await sandbox.restoreBackup(handle);
    const restoredId = handle.id;
    let reservationMoved = false;
    const committed = await commitManifestUpdate(bucket, (current) => {
      const authority = current.pendingRestoreId ?? current.currentId;
      if (authority && authority !== restoredId) {
        reservationMoved = true;
        return current;
      }
      reservationMoved = false;
      return {
        ...current,
        currentId: restoredId,
        pendingRestoreId: null,
        lastLiveId: restoredId,
        lastRestoreOutcome: {
          at: new Date().toISOString(),
          kind: 'restored',
          backupId: restoredId,
        },
      };
    });
    if (!committed) {
      restored = false;
      throw new Error('Backup manifest CAS failed while completing restore');
    }
    if (!reservationMoved) {
      await bucket.delete(RESTORE_NEEDED_KEY);
    }
    restored = true;
    console.log(`[persistence] Restore complete in ${Date.now() - t0}ms`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    const name = err instanceof Error ? err.name : undefined;
    const backupUnavailable =
      code === 'BACKUP_EXPIRED' ||
      code === 'BACKUP_NOT_FOUND' ||
      name === 'BackupExpiredError' ||
      name === 'BackupNotFoundError' ||
      msg.includes('BACKUP_EXPIRED') ||
      msg.includes('BACKUP_NOT_FOUND') ||
      msg.startsWith('BackupExpiredError:') ||
      msg.startsWith('BackupNotFoundError:');
    if (backupUnavailable) {
      console.log(
        `[persistence] Backup ${handle.id} expired/gone, conditionally invalidating state`,
      );
      const kind =
        code === 'BACKUP_NOT_FOUND' || msg.includes('BACKUP_NOT_FOUND')
          ? 'missing-continue'
          : 'expired-continue';
      const recorded = await commitManifestUpdate(bucket, (current) => ({
        ...current,
        currentId: current.currentId === handle.id ? null : current.currentId,
        pendingRestoreId:
          current.pendingRestoreId === handle.id ? null : current.pendingRestoreId,
        lastRestoreOutcome: { at: new Date().toISOString(), kind, backupId: handle.id },
      }));
      if (!recorded) {
        restored = false;
        throw new Error('Backup manifest CAS failed while recording expired restore', {
          cause: err,
        });
      }
      const invalidated = storedHandle
        ? await bucket.put(HANDLE_KEY, 'null', {
            onlyIf: { etagMatches: storedHandle.etag },
          })
        : await bucket.put(HANDLE_KEY, 'null');
      if (invalidated) {
        await bucket.delete(RESTORE_NEEDED_KEY);
        restored = true;
      } else {
        restored = false;
        throw new Error(
          'Backup handle changed while restoring; retry to restore the newer backup',
          {
            cause: err,
          },
        );
      }
    } else {
      console.error(`[persistence] Restore failed:`, err);
      throw err;
    }
  }
}

/**
 * Create a new snapshot of /home/openclaw (config + workspace + skills).
 *
 * Creates and persists a replacement before retiring the previous snapshot,
 * so a failed backup cannot make the old state unavailable.
 *
 * The Sandbox SDK only allows backup of directories under /home, /workspace,
 * /tmp, or /var/tmp. The Dockerfile sets HOME=/home/openclaw and symlinks
 * /root/.openclaw and /root/clawd there.
 */
async function workspaceFingerprint(sandbox: Sandbox): Promise<string | null> {
  try {
    const listing = await sandbox.exec(
      `find ${BACKUP_DIR} -printf '%p %s %T@\\n' 2>/dev/null | sort`,
    );
    const text = listing.stdout ?? '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function createSnapshot(
  sandbox: Sandbox,
  bucket: R2Bucket,
  source: BackupSource = 'manual',
): Promise<{ id: string; dir: string; skipped?: boolean }> {
  return withBackupOperationLease(bucket, async (lease) =>
    createSnapshotUnderLease(sandbox, bucket, lease, source, {
      skipUnchanged: source === 'cron',
    }),
  );
}

/** Create a snapshot while the caller already owns the shared backup lease. */
export async function createSnapshotUnderLease(
  sandbox: Sandbox,
  bucket: R2Bucket,
  lease: BackupOperationLease,
  source: BackupSource = 'manual',
  options: { skipUnchanged?: boolean } = {},
): Promise<{ id: string; dir: string; skipped?: boolean }> {
  await lease.renew();
  const manifest = await reconcileBackupAuthority(bucket);

  const fingerprint = await workspaceFingerprint(sandbox);
  if (options.skipUnchanged && fingerprint) {
    const current = manifest.generations.find((row) => row.id === manifest.currentId);
    if (current?.fingerprint === fingerprint) {
      const remaining = remainingTtlMs(current.createdAt, current.ttl, Date.now());
      if (remaining > NEAR_EXPIRY_MS) {
        const skipped: BackupManifest = { ...manifest, lastSkipAt: new Date().toISOString() };
        const stored = await getManifestWithEtag(bucket);
        await putManifest(bucket, skipped, stored?.etag ?? null);
        console.log('[persistence] Skipping snapshot; fingerprint unchanged and TTL remaining');
        return { id: current.id, dir: current.dir, skipped: true };
      }
    }
  }

  try {
    const lsResult = await sandbox.exec(`ls ${BACKUP_DIR}/clawd/ 2>&1 || echo "(empty)"`);
    console.log(`[persistence] Pre-backup ${BACKUP_DIR}/clawd/:`, lsResult.stdout?.trim());
  } catch {
    // non-fatal
  }

  await lease.renew();
  console.log('[persistence] Creating backup...');
  const t0 = Date.now();
  const handle = await sandbox.createBackup({
    dir: BACKUP_DIR,
    ttl: SNAPSHOT_TTL_SECONDS,
  });

  await lease.renew();
  const details = await readCreatedBackupDetails(bucket, handle);
  const generation: BackupGeneration = {
    id: handle.id,
    dir: handle.dir,
    source,
    verification: details.archiveEtag ? 'stored-etag' : 'legacy',
    fingerprint: fingerprint ?? undefined,
    ...details,
  };

  const nextManifest: BackupManifest = {
    ...manifest,
    currentId: manifest.pendingRestoreId ? manifest.currentId : handle.id,
    lastLiveId: manifest.pendingRestoreId ? manifest.lastLiveId : handle.id,
    generations: [generation, ...manifest.generations.filter((row) => row.id !== handle.id)],
  };

  const storedManifest = await getManifestWithEtag(bucket);
  try {
    const committed = await putManifest(bucket, nextManifest, storedManifest?.etag ?? null);
    if (!committed) {
      await deleteBackupObjectsBestEffort(bucket, handle, 'orphaned new');
      throw new Error('Backup manifest CAS failed');
    }
  } catch (error) {
    await deleteBackupObjectsBestEffort(bucket, handle, 'orphaned new');
    throw error;
  }

  await lease.renew();
  const authorityId = authorityHandleId(nextManifest) ?? handle.id;
  const authorityGeneration =
    nextManifest.generations.find((row) => row.id === authorityId) ?? generation;
  try {
    await storeHandle(bucket, { id: authorityGeneration.id, dir: authorityGeneration.dir });
  } catch (error) {
    // Manifest already committed. Repair on the next leased call.
    console.warn('[persistence] Handle write lagged the manifest; will repair on next lease', error);
  }

  await lease.renew();
  try {
    await commitPrune(bucket, { ...nextManifest, lastError: null });
  } catch (error) {
    console.warn('[persistence] Prune lagged; extra generations may remain', error);
  }

  console.log(`[persistence] Backup ${handle.id} created in ${Date.now() - t0}ms`);
  return handle;
}

/**
 * Get the persisted backup ID and handle upload time for status reporting.
 */
export interface BackupStatus {
  lastBackupId: string | null;
  lastSync: string | null;
  health: BackupHealth;
  remainingTtlSeconds: number | null;
  pendingRestoreId: string | null;
  lastSkipAt: string | null;
  lastError: { at: string; code: string } | null;
  lastRestoreOutcome: RestoreOutcome | null;
  retention: number;
  generations: Array<{
    id: string;
    createdAt: string;
    source: BackupSource;
    verification: BackupVerification;
    sizeBytes: number;
    health: BackupHealth;
    remainingTtlSeconds: number | null;
    isCurrent: boolean;
    isPendingRestore: boolean;
  }>;
}

export async function getBackupStatus(bucket: R2Bucket): Promise<BackupStatus> {
  let read = await readManifest(bucket);
  if (read.status === 'corrupt') {
    await reconcileBackupAuthority(bucket);
    read = await readManifest(bucket);
  }
  const handle = await getStoredHandle(bucket);
  const manifest = read.status === 'ok' ? read.manifest : emptyManifest();
  const metadata = handle ? await bucket.head(HANDLE_KEY) : null;
  const now = Date.now();

  const generations = await Promise.all(
    manifest.generations.map(async (generation) => {
      const health = await classifyBackupHealth(
        bucket,
        { id: generation.id, dir: generation.dir },
        generation.verification === 'stored-etag' ? generation.archiveEtag : null,
        now,
      );
      const remaining = remainingTtlMs(generation.createdAt, generation.ttl, now);
      return {
        id: generation.id,
        createdAt: generation.createdAt,
        source: generation.source,
        verification: generation.verification,
        sizeBytes: generation.sizeBytes,
        health,
        remainingTtlSeconds: remaining > 0 ? Math.floor(remaining / 1000) : 0,
        isCurrent: generation.id === manifest.currentId,
        isPendingRestore: generation.id === manifest.pendingRestoreId,
      };
    }),
  );

  const current = generations.find((row) => row.id === (handle?.id ?? manifest.currentId));
  const health =
    manifest.lastError?.code === 'corrupt-manifest' && generations.length === 0
      ? 'corrupt'
      : (current?.health ?? (handle ? await classifyBackupHealth(bucket, handle) : 'none'));
  return {
    lastBackupId: handle?.id ?? manifest.currentId,
    lastSync: metadata?.uploaded.toISOString() ?? null,
    health,
    remainingTtlSeconds: current?.remainingTtlSeconds ?? null,
    pendingRestoreId: manifest.pendingRestoreId,
    lastSkipAt: manifest.lastSkipAt,
    lastError: manifest.lastError,
    lastRestoreOutcome: manifest.lastRestoreOutcome,
    retention: manifest.retention,
    generations,
  };
}

export async function validateGeneration(
  bucket: R2Bucket,
  id: string,
): Promise<{ id: string; health: BackupHealth }> {
  const stored = await getManifestWithEtag(bucket);
  const generation = stored?.manifest.generations.find((row) => row.id === id);
  const handle = generation
    ? { id: generation.id, dir: generation.dir }
    : { id, dir: BACKUP_DIR };
  const health = await classifyBackupHealth(
    bucket,
    handle,
    generation?.verification === 'stored-etag' ? generation.archiveEtag : null,
  );
  return { id, health };
}

export async function reserveRestore(bucket: R2Bucket, id: string): Promise<void> {
  await withBackupOperationLease(bucket, async () => {
    const manifest = await reconcileBackupAuthority(bucket);
    const generation = manifest.generations.find((row) => row.id === id);
    if (!generation) {
      throw new Error('Generation not found');
    }
    const health = await classifyBackupHealth(
      bucket,
      generation,
      generation.verification === 'stored-etag' ? generation.archiveEtag : null,
    );
    if (health !== 'valid' && health !== 'near-expiry') {
      throw new Error('Generation is not restorable via the app path');
    }
    const next: BackupManifest = {
      ...manifest,
      pendingRestoreId: id,
      lastLiveId: manifest.currentId ?? manifest.lastLiveId,
    };
    const stored = await getManifestWithEtag(bucket);
    const committed = await putManifest(bucket, next, stored?.etag ?? null);
    if (!committed) throw new Error('Backup manifest CAS failed');
    await storeHandle(bucket, { id: generation.id, dir: generation.dir });
    await bucket.put(RESTORE_NEEDED_KEY, '1');
  });
}

export async function cancelRestoreReservation(bucket: R2Bucket): Promise<void> {
  await withBackupOperationLease(bucket, async () => {
    const manifest = await reconcileBackupAuthority(bucket);
    const liveId = manifest.lastLiveId ?? manifest.currentId;
    const live = manifest.generations.find((row) => row.id === liveId);
    const next: BackupManifest = { ...manifest, pendingRestoreId: null };
    const stored = await getManifestWithEtag(bucket);
    const committed = await putManifest(bucket, next, stored?.etag ?? null);
    if (!committed) throw new Error('Backup manifest CAS failed');
    if (live) {
      await storeHandle(bucket, { id: live.id, dir: live.dir });
    }
    await bucket.delete(RESTORE_NEEDED_KEY);
  });
}

export function isValidRetention(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_RETENTION && value <= MAX_RETENTION;
}

export async function setBackupRetention(bucket: R2Bucket, retention: number): Promise<number> {
  if (!isValidRetention(retention)) {
    throw new Error(`retention must be an integer from ${MIN_RETENTION} to ${MAX_RETENTION}`);
  }
  await withBackupOperationLease(bucket, async () => {
    const manifest = await reconcileBackupAuthority(bucket);
    await commitPrune(bucket, { ...manifest, retention });
  });
  return retention;
}

export async function recordBackupError(bucket: R2Bucket, code: string): Promise<void> {
  await withBackupOperationLease(bucket, async () => {
    const committed = await commitManifestUpdate(bucket, (current) => ({
      ...current,
      lastError: { at: new Date().toISOString(), code },
    }));
    if (!committed) throw new Error('Backup manifest CAS failed');
  });
}
