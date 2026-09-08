# Backup restore drill

事前検証 (`POST /api/admin/storage/generations/:id/validate`) is not a restore drill. It only checks UUID, metadata TTL (with the SDK 60s buffer), archive size, and the R2 object etag when one was stored. A multipart etag is not a whole-file MD5, and preflight does not extract squashfs or prove application data.

## Isolated restore drill

1. Confirm the generation health is `valid` or `near-expiry`.
2. Create a 復元予約 for that generation. Admin UI must show 復元予約中, not 復元完了.
3. Recreate the container so a cold start consumes `restore-needed`.
4. After the gateway is ready, check:
   - paired devices still appear in `/_admin/`
   - an existing session continues
   - a known workspace file under `/home/openclaw/clawd` is present
5. Record timestamps. Do not treat an `expired-continue` or `missing-continue` cold start as a successful restore.

## Retention vs restorable copies

The Worker keeps a bounded history (default 5 rows). SDK snapshot TTL is 7 days. Older history rows can remain after they are no longer restorable via the app path. R2 does not delete objects at TTL expiry; the SDK rejects expired restore.
