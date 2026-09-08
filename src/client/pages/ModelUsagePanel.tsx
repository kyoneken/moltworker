import { useCallback, useEffect, useState } from 'react';
import {
  AuthError,
  getSessionModel,
  getUsageSnapshot,
  listAdminModels,
  setSessionModel,
  type AdminModelRecord,
  type SessionModelResponse,
  type UsageSnapshotResponse,
} from '../api';

function formatReset(iso: string | null) {
  if (!iso) return 'なし';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ModelUsagePanel() {
  const [models, setModels] = useState<AdminModelRecord[]>([]);
  const [session, setSession] = useState<SessionModelResponse | null>(null);
  const [usage, setUsage] = useState<UsageSnapshotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [modelList, sessionModel, usageSnapshot] = await Promise.all([
        listAdminModels(),
        getSessionModel(),
        getUsageSnapshot(),
      ]);
      setModels(modelList.data);
      setSession(sessionModel);
      setUsage(usageSnapshot);
    } catch (err) {
      if (err instanceof AuthError) {
        setError('認証が必要です。Cloudflare Access でログインしてください。');
      } else {
        setError(err instanceof Error ? err.message : 'モデル利用状況の取得に失敗しました');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSelect = async (model: string) => {
    setSaving(true);
    try {
      const next = await setSessionModel(model);
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'セッションモデルの更新に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const limited = usage?.windows.some((window) => window.state === 'limited');
  const near = usage?.windows.some((window) => window.state === 'near');

  return (
    <section className="devices-section">
      <div className="section-header">
        <h2>モデルと利用量</h2>
        <button className="btn btn-secondary" onClick={() => void load()} disabled={saving}>
          更新
        </button>
      </div>
      {error && <p className="hint">{error}</p>}
      {limited && (
        <div className="error-banner">
          <span>レートまたは支出上限に達しました。自動フォールバックは無効です。同じモデルで後から再試行してください。</span>
        </div>
      )}
      {!limited && near && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>上限に近づいています</strong>
            <p>24時間または30日の窓が、設定上限の80%以上です。</p>
          </div>
        </div>
      )}
      <p className="hint">
        選択中のセッションモデル: {session?.model ?? '読み込み中'}（{session?.source ?? 'なし'}）。手動専用モデルは自動選択されません。
      </p>
      <div className="devices-grid">
        {models.map((model) => (
          <div key={model.id} className={`device-card ${model.primary ? 'paired' : 'pending'}`}>
            <div className="device-header">
              <span className="device-name">{model.name}</span>
              <span className={`device-badge ${model.primary ? 'paired' : 'pending'}`}>
                {model.primary ? 'プライマリ' : '手動のみ'}
              </span>
            </div>
            <div className="device-details">
              <div className="detail-row">
                <span className="label">ID</span>
                <span className="value">{model.id}</span>
              </div>
              <div className="detail-row">
                <span className="label">コンテキスト</span>
                <span className="value">{model.context_window.toLocaleString()}</span>
              </div>
              <div className="detail-row">
                <span className="label">ツール</span>
                <span className="value">{model.supports_tools ? 'あり' : 'なし'}</span>
              </div>
            </div>
            <div className="device-actions">
              <button
                className="btn btn-primary"
                disabled={saving || session?.model === model.id}
                onClick={() => void handleSelect(model.id)}
              >
                {session?.model === model.id ? '選択中' : 'このモデルを使う'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {usage && (
        <div className="device-details" style={{ marginTop: '1rem' }}>
          <p className="hint">{usage.message}</p>
          {usage.windows.map((window) => (
            <div key={window.window} className="detail-row">
              <span className="label">{window.window}</span>
              <span className="value">
                状態={window.state === 'limited' ? '制限中' : window.state === 'near' ? '逼迫' : window.state}
                ; 費用 {window.usedCostUsd ?? '—'}/{window.limitCostUsd ?? '—'} USD; トークン{' '}
                {window.usedTokens ?? '—'}/{window.limitTokens ?? '—'}; リセット{' '}
                {formatReset(window.resetAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
