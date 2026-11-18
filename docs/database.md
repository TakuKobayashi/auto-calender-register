# データベース運用

## 起動と接続

Docker Desktopを起動して実行します。

```powershell
npm run task db:setup
```

PostgreSQL 17を起動し、未適用のマイグレーションを適用します。

| 項目             | 値                         |
| ---------------- | -------------------------- |
| 接続先           | `127.0.0.1:55432`          |
| DB名・ユーザー名 | `auto_calender_register`   |
| 認証             | パスワードなし（trust）    |
| データ保存先     | Dockerの名前付きボリューム |

別のDBへ接続する場合は `DATABASE_URL` を設定します。

```dotenv
DATABASE_URL=postgresql://auto_calender_register@127.0.0.1:55432/auto_calender_register
```

## 保存内容

| テーブル          | 内容                           |
| ----------------- | ------------------------------ |
| `mail_accounts`   | メールサービス・アカウント     |
| `mailboxes`       | フォルダー・取得位置・走査期間 |
| `mails`           | メール本文・取得結果・選別結果 |
| `extractions`     | LLM抽出結果のキャッシュ        |
| `runs`            | コマンドの実行履歴             |
| `calendar_states` | 登録判断・理由・Google予定ID   |
| `sync_attempts`   | 予定ごとの照合・登録履歴       |

定義: [schema.ts](../src/db/schema.ts)、[初期マイグレーション](../drizzle/0000_init.sql)。

```powershell
npm run db:status
npm run db:decisions
```

`db:decisions` で送信元・件名・判定理由を確認できます。

## 再実行

指定期間のメール一覧を取得し、未保存・取得失敗の本文を読み取ります。
走査開始日はDBに保持し、より古い日を指定した場合は取得範囲を広げます。
保存済みの本文は、元メールのアーカイブ・削除後も判定対象に残ります。

LLM抽出結果は入力・プロンプト・スキーマ・モデル名・モデルdigestで識別します。
同じ条件ではキャッシュを再利用し、予定日時は実行時点で再検証します。キャッシュ利用時もOllamaの起動が必要です。

Googleの既存予定は実行ごとに取得します。登録判断は `shouldRegister` と理由に記録します。
未確定・完了・取消・期限切れ・根拠不足・重複疑いは登録対象外です。
取得・API処理の失敗は非ゼロ終了し、次回実行で再試行します。

## SQLダンプと復元

```powershell
npm run db:dump
npm run db:restore

# DBの準備と復元
npm run task db:import

# 保存先を指定
npm run db:dump -- --directory db/backup
npm run db:restore -- --directory db/backup

# 既存データを置き換えて復元
npm run db:restore -- --replace
```

出力先:

```text
db/dumps/
  latest.txt
  snapshot-YYYY-MM-DDT.../
    manifest.json
    mail_accounts/data.sql
    mailboxes/data.sql
    mails/data.sql
    extractions/data.sql
    runs/data.sql
    calendar_states/data.sql
    sync_attempts/data.sql
```

各SQLファイルは1レコードにつき1行のINSERT文と、採番シーケンスの復元SQLを含みます。
`latest.txt` は最新の完了済みスナップショットを指します。復元時はスナップショットのディレクトリも直接指定できます。

復元前にマイグレーションを適用してください。通常は空DBへ復元し、`--replace` は全7テーブルの既存データを置き換えます。
復元はテーブル一覧・チェックサムを確認し、1トランザクションで実行します。途中失敗時は全体をロールバックします。
ダンプにはメール本文と予定が含まれ、`db/dumps/` はGit管理対象外です。

## GitHub Actions

ワークフローは同じ `compose.yml` と `npm run task db:setup` を使用します。
DB起動 → マイグレーション → SQL復元 → メール選別・照合 → SQLダンプ → DB停止の順に実行します。

ジョブ間で状態を引き継ぐには、次のステップを保存先に合わせて追加してください。

1. 復元前に保存先から `db/dumps/` を取得する。
2. ダンプ完了後に `db/dumps/` を保存先へアップロードする。

保存先は未設定です。Runner内のDBとファイルはジョブ終了後に失われます。
認証情報の設定は [Googleカレンダー連携](google-calendar.md#github-actions) を参照してください。

## 管理コマンド

| コマンド              | 用途                                     |
| --------------------- | ---------------------------------------- |
| `npm run db:up`       | 起動・ヘルスチェック                     |
| `npm run db:stop`     | 停止                                     |
| `npm run db:down`     | コンテナー削除（データボリュームは維持） |
| `npm run db:logs`     | PostgreSQLログ                           |
| `npm run db:generate` | マイグレーション生成                     |
| `npm run db:migrate`  | マイグレーション適用                     |
| `npm run db:studio`   | Drizzle Studio起動                       |
| `npm run test:db`     | 一時DBによる統合テスト                   |
