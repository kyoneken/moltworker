import { useState, useEffect, useCallback } from 'react';
import {
  listDevices,
  approveDevice,
  approveAllDevices,
  restartGateway,
  getStorageStatus,
  triggerSync,
  validateBackupGeneration,
  reserveBackupRestore,
  cancelBackupRestore,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
  type StorageStatusResponse,
} from '../api';
import ModelUsagePanel from './ModelUsagePanel';
import './AdminPage.css';

function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

function formatSyncTime(isoString: string | null) {
  if (!isoString) return 'なし';
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return date.toLocaleString();
}

function healthLabel(health: string | undefined): string {
  switch (health) {
    case 'valid':
      return '有効';
    case 'near-expiry':
      return '期限間近';
    case 'expired':
      return '期限切れ';
    case 'missing':
      return '欠落';
    case 'corrupt':
      return '破損';
    case 'none':
      return 'なし';
    default:
      return health ?? '不明';
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return '手動';
    case 'cron':
      return '定期';
    case 'migrated':
      return '移行';
    default:
      return source;
  }
}

function formatTimeAgo(ts: number) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

export default function AdminPage() {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [restartInProgress, setRestartInProgress] = useState(false);
  const [syncInProgress, setSyncInProgress] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data: DeviceListResponse = await listDevices();
      setPending(data.pending || []);
      setPaired(data.paired || []);

      if (data.error) {
        setError(data.error);
      } else if (data.parseError) {
        setError(`解析エラー: ${data.parseError}`);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('認証が必要です。Cloudflare Access でログインしてください。');
      } else {
        setError(err instanceof Error ? err.message : 'デバイス一覧の取得に失敗しました');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus();
      setStorageStatus(status);
    } catch (err) {
      console.error('Failed to fetch storage status:', err);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    fetchStorageStatus();
  }, [fetchDevices, fetchStorageStatus]);

  const handleApprove = async (requestId: string) => {
    setActionInProgress(requestId);
    try {
      const result = await approveDevice(requestId);
      if (result.success) {
        await fetchDevices();
      } else {
        setError(result.error || '承認に失敗しました');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'デバイスの承認に失敗しました');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleApproveAll = async () => {
    if (pending.length === 0) return;
    setActionInProgress('all');
    try {
      const result = await approveAllDevices();
      if (result.failed && result.failed.length > 0) {
        setError(`${result.failed.length} 台の承認に失敗しました`);
      }
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'デバイスの一括承認に失敗しました');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRestartGateway = async () => {
    if (
      !confirm(
        'コンテナを再作成しますか？次回アクセス時に R2 からの復元を試みます。接続中のクライアントは一時切断されます。',
      )
    ) {
      return;
    }
    setRestartInProgress(true);
    try {
      const result = await restartGateway();
      if (result.success) {
        setError(null);
        alert(
          'コンテナ再作成を開始しました。次回アクセス時に R2 からの復元を試みます。接続中のクライアントは一時切断されます。',
        );
      } else {
        setError(result.error || 'ゲートウェイの再作成に失敗しました');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ゲートウェイの再作成に失敗しました');
    } finally {
      setRestartInProgress(false);
    }
  };

  const handleSync = async () => {
    setSyncInProgress(true);
    try {
      const result = await triggerSync();
      if (result.success) {
        await fetchStorageStatus();
        setError(null);
      } else {
        setError(result.error || 'バックアップに失敗しました');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'バックアップに失敗しました');
    } finally {
      setSyncInProgress(false);
    }
  };

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            閉じる
          </button>
        </div>
      )}

      {storageStatus && !storageStatus.configured && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>R2 ストレージが未設定です</strong>
            <p>
              コンテナ再起動時にペア済みデバイスと会話が失われます。永続化するには R2
              を設定してください。手順は{' '}
              <a
                href="https://github.com/kyoneken/moltworker"
                target="_blank"
                rel="noopener noreferrer"
              >
                README
              </a>{' '}
              を参照してください。
            </p>
            {storageStatus.missing && (
              <p className="missing-secrets">不足: {storageStatus.missing.join(', ')}</p>
            )}
          </div>
        </div>
      )}

      {storageStatus?.configured && (
        <div
          className={
            storageStatus.lastRestoreOutcome?.kind === 'expired-continue' ||
            storageStatus.lastRestoreOutcome?.kind === 'missing-continue' ||
            storageStatus.health === 'expired' ||
            storageStatus.health === 'missing' ||
            storageStatus.health === 'corrupt'
              ? 'warning-banner'
              : 'success-banner'
          }
        >
          <div className="storage-status">
            <div className="storage-info">
              <span>{storageStatus.message}</span>
              <span className="last-sync">
                最終バックアップ: {formatSyncTime(storageStatus.lastSync)} · 健全性:{' '}
                {healthLabel(storageStatus.health)}
              </span>
              {storageStatus.pendingRestoreId && (
                <span className="last-sync">復元予約中: {storageStatus.pendingRestoreId}</span>
              )}
              {(storageStatus.lastRestoreOutcome?.kind === 'expired-continue' ||
                storageStatus.lastRestoreOutcome?.kind === 'missing-continue') && (
                <span className="last-sync">
                  期限切れなどのため以前のデータは復元されていません。空の状態からの新規スナップショットは復元成功ではありません。
                </span>
              )}
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSync}
              disabled={syncInProgress}
            >
              {syncInProgress && <ButtonSpinner />}
              {syncInProgress ? 'バックアップ中...' : '今すぐバックアップ'}
            </button>
          </div>
          {storageStatus.generations && storageStatus.generations.length > 0 && (
            <div className="backup-history">
              {storageStatus.generations.map((generation) => (
                <div key={generation.id} className="backup-history-row">
                  <span>
                    {generation.id.slice(0, 8)} · {healthLabel(generation.health)} ·{' '}
                    {sourceLabel(generation.source)}
                    {generation.isPendingRestore ? ' · 復元予約' : ''}
                  </span>
                  <span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={async () => {
                        try {
                          const result = await validateBackupGeneration(generation.id);
                          setError(`事前検証 ${result.id}: ${healthLabel(result.health)}`);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '事前検証に失敗しました');
                        }
                      }}
                    >
                      事前検証
                    </button>{' '}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={async () => {
                        if (
                          !confirm(
                            'この世代を復元予約しますか？適用にはコンテナ再作成が必要です。',
                          )
                        ) {
                          return;
                        }
                        try {
                          await reserveBackupRestore(generation.id);
                          await fetchStorageStatus();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '復元予約に失敗しました');
                        }
                      }}
                    >
                      復元予約
                    </button>
                  </span>
                </div>
              ))}
              {storageStatus.pendingRestoreId && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    await cancelBackupRestore();
                    await fetchStorageStatus();
                  }}
                >
                  復元予約を取り消す
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <ModelUsagePanel />

      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>ゲートウェイ操作</h2>
          <button
            className="btn btn-danger"
            onClick={handleRestartGateway}
            disabled={restartInProgress}
          >
            {restartInProgress && <ButtonSpinner />}
            {restartInProgress ? '再作成中...' : 'コンテナを再作成'}
          </button>
        </div>
        <p className="hint">
          設定反映や復元予約の適用のためにコンテナを再作成します。再作成成功はデータ復元成功ではありません。先にスナップショットの健全性を確認してください。期限切れの SDK
          バックアップは、R2 上に残っていても通常の復元経路では使えません。
        </p>
      </section>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>デバイスを読み込み中...</p>
        </div>
      ) : (
        <>
          <section className="devices-section">
            <div className="section-header">
              <h2>承認待ちのペアリング</h2>
              <div className="header-actions">
                {pending.length > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={handleApproveAll}
                    disabled={actionInProgress !== null}
                  >
                    {actionInProgress === 'all' && <ButtonSpinner />}
                    {actionInProgress === 'all'
                      ? '承認中...'
                      : `すべて承認 (${pending.length})`}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={fetchDevices} disabled={loading}>
                  更新
                </button>
              </div>
            </div>
            {pending.length === 0 ? (
              <div className="empty-state">
                <p>承認待ちのリクエストはありません</p>
                <p className="hint">
                  未ペアのデバイスが接続を試みると、ここに表示されます。
                </p>
              </div>
            ) : (
              <div className="devices-grid">
                {pending.map((device) => (
                  <div key={device.requestId} className="device-card pending">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || '不明なデバイス'}
                      </span>
                      <span className="device-badge pending">承認待ち</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">プラットフォーム:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">クライアント:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">モード:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">役割:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      {device.remoteIp && (
                        <div className="detail-row">
                          <span className="label">IP:</span>
                          <span className="value">{device.remoteIp}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">要求日時:</span>
                        <span className="value" title={formatTimestamp(device.ts)}>
                          {formatTimeAgo(device.ts)}
                        </span>
                      </div>
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-success"
                        onClick={() => handleApprove(device.requestId)}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === device.requestId && <ButtonSpinner />}
                        {actionInProgress === device.requestId ? '承認中...' : '承認'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="devices-section">
            <div className="section-header">
              <h2>ペア済みデバイス</h2>
            </div>
            {paired.length === 0 ? (
              <div className="empty-state">
                <p>ペア済みデバイスはありません</p>
              </div>
            ) : (
              <div className="devices-grid">
                {paired.map((device) => (
                  <div key={device.deviceId} className="device-card paired">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || '不明なデバイス'}
                      </span>
                      <span className="device-badge paired">ペア済み</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">プラットフォーム:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">クライアント:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">モード:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">役割:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">ペア日時:</span>
                        <span className="value" title={formatTimestamp(device.approvedAtMs)}>
                          {formatTimeAgo(device.approvedAtMs)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
