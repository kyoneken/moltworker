# 本人によるハーネス動作確認

PR #66の更新後に、実際に使うクライアントだけ確認してください。全5種類のインストールは不要です。APMが依存とMCPを宣言どおり導入し、クライアントの読み込み、Hookの有効化、1Password Desktop承認、OAuth認証は別に確認します。

## 1. 準備

- PRブランチの使い捨て作業コピーを用意する。日常利用する設定に初回テストを直接適用しない。
- 作業コピーごとに対象クライアントを1つだけ選ぶ。APMのMCP installは、別クライアントの管理対象エントリをcleanすることがある。
- Node.js 22、APM 0.29.0を用意する。`verify`を使う場合はPython 3.11以上（`tomllib`）、Grokを選ぶ場合はGrok CLIも必要。
- `harness/vendor/coding-agent-harness` はCloneに同梱済みで、`harness/source-lock.json` の固定ref・指定ファイルと照合される。追加の取得操作は不要。
- 使用クライアント、CLI版、1Password Desktop版を記録する。環境変数の全件表示や認証情報のコピーは不要。

以下は Codex/Claude の基本手順です。`--target` を実際に使うクライアントへ
置き換えてください。Cursor、Grok Build、AntigravityはMCP方式が異なるため、
直後のターゲット別手順も実行します。

```sh
npm run test:harness
node scripts/harness.mjs source --target codex
apm install --only apm --target codex --frozen
apm install --only mcp --target codex --frozen
apm compile --target codex --root .harness/compiled/codex
node scripts/harness.mjs verify --target codex
node scripts/harness.mjs doctor --target codex
```

期待結果: `source`、APMの3コマンド、`verify`が終了コード0。doctorのlive項目は実通信をしていないため `not-verified`。Antigravityの1Passwordとproject-local remote MCPは `incompatible` であり、接続成功として記録しない。

Cursorでは、MCP install後にAPMのHookをCursor形式へ変換します。

```sh
node scripts/harness.mjs adapt --target cursor
```

Grok BuildではMCP installを実行せず、native CLIを使います。

```sh
apm install --only apm --target grok-build --frozen
apm compile --target grok-build --root .harness/compiled/grok-build
grok mcp add --scope project 1password -- 1password-mcp
grok mcp add --scope project cloudflare-docs https://docs.mcp.cloudflare.com/mcp
node scripts/harness.mjs verify --target grok-build
```

AntigravityはAPMのskills/Hookだけを導入します。

```sh
apm install --only apm --target antigravity --frozen
apm compile --target antigravity --root .harness/compiled/antigravity
node scripts/harness.mjs verify --target antigravity
```

## 2. 設定と作業ルールの読み込み

クライアントをこの作業コピーで開き直し、設定画面またはクライアントの一覧コマンドで確認します。

| 対象 | 見る場所 | 合格条件 |
| --- | --- | --- |
| Codex | `.codex/config.toml`、`.harness/compiled/codex/AGENTS.md`、`/hooks` | MCP一覧に1PasswordとDocsが各1つ。プロジェクトHookをレビュー・信頼済みにする |
| Claude Code | `.mcp.json`、`.claude/settings.json`、`.claude/rules/` | プロジェクトMCPを承認でき、Hook設定のエラーが出ない |
| Cursor | `.cursor/mcp.json`、`.cursor/hooks.json`、`.cursor/rules/` | MCP一覧が正しく、lower-camel形式のHookを読み込める |
| Grok Build | `.grok/config.toml`、`.grok/rules/`、`.grok/skills/` | 下記のGrokコマンドでproject scopeのMCPを読み込める。native Hookの同等動作は要求しない |
| Antigravity | `.agents/rules/`、`.agents/skills/`、既存 `.agents/hooks.json` | 共通手順に到達でき、既存ポリシーを保持する。未対応MCPファイルを作らない |

エージェントに「このリポジトリのGitHub操作先、利用できるインターフェース、PRマージ条件、作業用Skillの場所を説明して」と依頼する。`kyoneken/moltworker`、GitHub MCP限定、人間によるマージ承認、共通Skill参照が説明されれば合格です。

Hookの拒否動作は `npm run test:codex-hooks`、`npm run test:agy-hooks` とharnessの合成イベントテストで確認します。実GitHubへの禁止操作や秘密取得を試して確認しないでください。native Hookの実発火は無害なコマンドで観測し、未観測なら未確認として記録します。

## 3. 1Password Desktop — 本人操作が必要

対応する4クライアントで、1Password MCPの接続を有効にします。Desktopが要求する承認は、意図したテスト用Environmentに限って行います。

- エージェントへの依頼: 「許可済みEnvironmentのメタデータを確認し、成功か失敗だけ報告して。秘密値を取得・表示しないで」
- 接続・承認が通ることを確認する。Environment名や変数名をIssueへ貼る必要はない。
- Desktopをlockし再試行する。必要な再承認が案内され、別の認証方法へ勝手に切り替わらないことを確認する。
- `op read`、環境変数全件表示、`.env`/`.dev.vars`生成、mount内容の表示は行わない。

既存の非管理 `1password` 設定と衝突した場合、値を貼らず `conflict` と記録します。導入を通すために既存設定を削除する必要はありません。

## 4. Cloudflare / GitHub MCP

**Docs:** 「Cloudflare Docs MCPでWorkersの公開ドキュメントを1件検索して、出典URLを示して」と依頼する。公開文書検索が成功すれば合格。DocsとObservabilityの認証要件は別です。

**Observability（使う場合だけ）:** 次を実行してクライアントを再読み込みする。

```sh
apm install --mcp cloudflare-observability --transport streamable-http \
  --url https://observability.mcp.cloudflare.com/mcp --target codex
apm install --only mcp --target codex --frozen
node scripts/harness.mjs verify --target codex
```

Claude and Cursor can use the same APM command with their target name; run the
Cursor adapter afterward. Grok Build uses its native project MCP command with
the Observability URL:

```sh
grok mcp add --scope project cloudflare-observability https://observability.mcp.cloudflare.com/mcp
```

Antigravity remains unsupported for project-local remote MCP.

クライアントの認証画面からOAuthを完了し、接続・ツール一覧を確認する。標準確認では実ログ・プロンプト・応答本文を取得しない。baseへ戻す場合は `apm.yml` からその項目を削除して `apm lock` を実行し、dry-runで削除対象を確認してからAPMのclean操作を行う。独自serverは残す。

**GitHub:** `skills/harness-doctor/SKILL.md` を指定し、GitHub MCPでget_me、`kyoneken/moltworker`のIssue読み取り、[Project 2](https://github.com/users/kyoneken/projects/2)のフィールド読み取りを別々に確認する。401は認証、403は権限、ツール未公開は `missing-tool` として記録する。get_me/Projectの失敗からIssueも利用不可と判断しない。書き込みによる権限テストは不要。

## 5. 再実行と削除

一度APMを適用した使い捨て作業コピーで、同じinstallを再実行して重複がないことを確認します。APMのclean/uninstallを使う場合はdry-runで対象を確認し、既存ユーザー設定を削除しないことを確認します。

```sh
apm install --only apm --target codex --frozen
apm install --only mcp --target codex --frozen
node scripts/harness.mjs verify --target codex
```

別の使い捨てコピーで管理設定を無害な値に手編集した場合、`verify`が失敗し、編集値が残ることを確認します。競合解決で `--force` を使わないでください。

## 結果の記録

| クライアント・版 | 設定生成 | native読込 | Hook発火 | MCP接続 | 本人認証 | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| 使用したものだけ記載 | pass / fail | pass / not-verified | pass / not-verified / incompatible | serverごと | pass / not-verified | 固定理由のみ |

Issue/PRには成功・失敗・未確認とバージョンだけ共有してください。生ログ、設定全文、token、cookie、Environment名や秘密値は不要です。

## 自動確認の記録（2026-09-12）

固定版 APM 0.29.0 とロック済みソースを使い、一時ディレクトリで各 target の `apm install` → `apm compile` → 再実行を確認しました。Codex、Claude、CursorではMCP設定も確認しています。GrokはAPMのMCP target非対応のため、native `grok mcp add --scope project`を使います。Antigravityはremote MCPを導入しません。

この確認は設定の生成・所有範囲・復元を対象とします。各アプリでの設定読込、Hook の発火、1Password Desktop 承認、MCP 接続、OAuth は上記の手動確認に残っています。
