# バックアップ復旧訓練

事前検証（`POST /api/admin/storage/generations/:id/validate`）は復旧訓練ではありません。確認するのは UUID、metadata の TTL（SDK の 60 秒バッファ込み）、アーカイブサイズ、保存済みなら R2 の etag だけです。multipart etag はファイル全体の MD5 ではなく、事前検証は squashfs を展開せず、アプリデータが使えることも証明しません。

## 隔離環境での復旧訓練

1. 対象世代の健全性が `有効` または `期限間近`（API 値は `valid` / `near-expiry`）であることを確認する。
2. その世代を復元予約する。Admin UI は「復元予約中」と出し、「復元完了」とは出さない。
3. コンテナを再作成し、cold start が `restore-needed` を消費するようにする。
4. ゲートウェイ準備後に次を確認する。
   - `/_admin/` にペア済みデバイスが表示される
   - 既存セッションが続く
   - `/home/openclaw/clawd` 配下の既知の workspace ファイルがある
5. 時刻を記録する。`expired-continue` や `missing-continue` の cold start を復元成功とみなさない。

## 履歴保持と復元可能な世代

Worker は件数上限付きの履歴を残します（既定 5 件）。SDK スナップショットの TTL は 7 日です。通常の復元経路では使えなくなったあとも、履歴行としては残ることがあります。TTL 切れで R2 オブジェクトが自動削除されるわけではなく、SDK が期限切れ restore を拒否します。
