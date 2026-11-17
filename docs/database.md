# PostgreSQL・処理記録・SQLダンプ

## 初回の準備と通常実行

Docker Desktopを起動して、次のコマンドを実行します。

```powershell
npm run task db:setup
npm run task calendar:sync
```

`db:setup` はPostgreSQL 17の起動とDrizzleマイグレーションを順に実行します。
ローカル・GitHub Actionsともにパスワード不要です。生成処理やDB用Secretの設定、`.env` の自動書き換えはありません。
マイグレーションはDrizzleの履歴を確認し、未適用分だけを適用します。既存テーブルやデータを毎回作り直しません。
既存の `DATABASE_URL` が外部DBを指す場合は `npm run db:migrate` を使い、ローカルComposeは起動不要です。
ローカルDBは `127.0.0.1:55432` で待ち受け、Dockerの名前付きボリュームへ保存します。
DB名・DBユーザー名は、プロジェクト名 `auto-calender-register` に合わせた `auto_calender_register` です。
既定の接続先は `postgresql://auto_calender_register@127.0.0.1:55432/auto_calender_register` です。
別の接続先を使う場合だけ `DATABASE_URL` を指定してください。

`calendar:dry-run`・`calendar:plan`・`calendar:register` は既定でDBに記録します。
`--database` で必須にでき、`--no-database` では従来のJSONのみの動作になります。
`calendar:sync` TaskはDB必須で、最後にSQLダンプを出力します。途中失敗の場合もTaskのdeferでダンプを試みます。

```powershell
npm run task calendar:sync SINCE=2026-10-01 CALENDAR_ID=primary MODEL=qwen3.5:9b

# Googleへ書き込まずに確認
npm run calendar:dry-run -- --since 2026-10-01 --database --ollama-model qwen3.5:9b
npm run calendar:plan -- --database
```

## テーブル設計の方針

Railsの慣例に合わせ、全6テーブルの主キーは自動採番の `id BIGINT` に統一しています。
各テーブルに `created_at`・`updated_at` を持たせ、外部キーは参照先の `id` と同じBIGINT型です。
UUID・ハッシュ文字列・複合列を主キーにしません。メールUIDや予定キー等の重複防止はUNIQUE制約で定義します。

| 関係                    | 外部キー                                               |
| ----------------------- | ------------------------------------------------------ |
| メール → メールボックス | `mails.mailbox_id → mailboxes.id`                      |
| 登録状態 → 元メール     | `calendar_states.source_mail_id → mails.id`            |
| 試行履歴 → 実行履歴     | `sync_attempts.run_id → runs.id`                       |
| 試行履歴 → 登録状態     | `sync_attempts.calendar_state_id → calendar_states.id` |

スキーマは [src/db/schema.ts](../src/db/schema.ts)、初期マイグレーションは `drizzle/0000_init.sql` です。
今回の設計は初期定義から作り直し、過去の追加マイグレーション・旧スナップショット・旧設計用の互換処理は持ちません。
参考: [Railsの主キー・テーブル作成規約](https://guides.rubyonrails.org/active_record_migrations.html)。

## 確認位置・再実行

| テーブル          | 保存するもの                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `mailboxes`       | アカウント等から作る識別子、フォルダー、UIDVALIDITY、走査開始日、最大確認UID、本文取得が全件成功した日時 |
| `mails`           | UIDごとの本文、取得失敗、最新の選別結果と根拠                                                            |
| `extractions`     | LLMの抽出結果。入力・プロンプト・スキーマ・モデル名・モデルdigestで識別                                  |
| `runs`            | 各コマンドの開始・終了・状態と集計                                                                       |
| `calendar_states` | 登録先ごとの予定の最新状態、試行回数、Google予定ID、手動判断                                             |
| `sync_attempts`   | 実登録モードの予定ごとの照合・登録履歴                                                                   |

最大UIDだけを見て古いメールを飛ばす方式にはしていません。小さいUIDの取得失敗を取りこぼすためです。
指定期間の一覧を確認し、本文はDBにないものだけ取得します。失敗は次回再取得します。
同じUIDでも、アカウント・フォルダー・UIDVALIDITYが異なれば別メールとして扱います。
DB利用時は最初に指定した開始日を維持し、後から古い開始日を指定した場合は範囲を広げます。
翌月になっても、過去に受信した未来の予定や保留候補が期間から外れないためです。
DBに取得済みの本文は、メールをアーカイブ・削除した後も判定対象として保持します。

ルール判定とメール間の取消・変更照合は毎回行います。LLMは同じ入力なら保存済みの抽出結果を再利用します。
抽出結果から現在時刻で再検証するため、時間が経って過去になった予定は登録されません。
モデルのdigestをOllamaから取得するため、同じ名前のモデルを更新した場合も次回実行時に自動で再抽出します。
キャッシュの版を手動で指定する環境変数は不要です。キャッシュ利用時もローカルOllamaの起動が必要です。
失敗したLLM呼び出しは成功キャッシュに保存せず次回再試行します。

DBの「登録済み」だけを理由にGoogle照合を省略することはありません。毎回Googleの状態を確認します。
同じDBで動く処理は対象ごとのPostgreSQL advisory lockで並行実行を防ぎます。
Google書き込み後にDB保存が失敗した場合も、次回は固定Google予定IDで突合します。
プロセス強制終了の実行履歴は `running` のまま残りますが、接続終了でロックは解放され、次回再試行できます。

## 保留・未確定の扱い

| 状態                 | 定期実行での動作                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `possible_duplicate` | その予定を登録せず記録。他の予定は続行。次回に最新カレンダーと再照合 |
| `pending`            | 確定通知待ち。自動的に確定へ変更しない。新しい確定メールを評価       |
| `review`             | 根拠不足・判定矛盾として記録。自動登録しない                         |
| `error`              | 失敗として記録。次回に再試行。コマンドは非ゼロ終了                   |

保留は時間が経っただけで登録されることはありません。重複疑いが解消しない場合は、手動で判断します。
開始日時を過ぎた予定は自動登録せず、保留一覧からも除外します。履歴データは残ります。
カレンダー照合の保留だけなら既定では終了コード0です。厳密に失敗扱いしたい場合は `--fail-on-hold` を付けます。
登録API失敗・未完了レポートは従来どおり非ゼロ終了します。

```powershell
npm run db:status
npm run db:holds
npm run db:reviews

# db:holds に表示されたtarget・eventKeyを指定
npm run db:resolve -- --target TARGET --event-key KEY --decision skip
npm run db:resolve -- --target TARGET --event-key KEY --decision duplicate --google-event-id GOOGLE_EVENT_ID
npm run db:resolve -- --target TARGET --event-key KEY --decision retry
```

`skip` は登録不要の判断を維持します。`duplicate` は指定した既存予定に紐付け、次回実行で存在を確認します。
紐付け先が消えていても自動新規登録せず保留に戻します。`retry` は手動判断を解除して通常照合へ戻します。
`retry` は強制登録ではありません。別の同時刻予定と区別できない場合などは、Google側で手動登録後に紐付けできます。
手動判断は登録先とOAuthリフレッシュトークンから作る識別子に紐付きます。再認証でトークンが変わった場合は再判断が必要です。
プレビューモードは運用中の `calendar_states` を上書きしません。

## SQLダンプと一括復元

```powershell
npm run db:dump
npm run db:restore

# 空のDBの準備から復元まで
npm run task db:import

# 保存先を指定
npm run db:dump -- --directory db/backup
npm run db:restore -- --directory db/backup

# 既存データを置き換える場合のみ明示指定
npm run db:restore -- --replace
```

出力例:

```text
db/dumps/
  latest.txt
  snapshot-2026-11-17T.../
    manifest.json
    mailboxes/data.sql
    mails/data.sql
    extractions/data.sql
    runs/data.sql
    calendar_states/data.sql
    sync_attempts/data.sql
```

各SQLファイルは **1レコードにつき1行のINSERT文** です。COPYや複数レコードのVALUES文を使用しません。
`id` と外部キーもそのまま出力し、各ファイルの末尾には採番シーケンスを再開するSQLを出力します。
復元後の自動採番が既存IDと衝突しないよう、削除済みレコードを含むシーケンスの進行位置も保持します。
改行・引用符・逆スラッシュ・日本語・JSON・NULLを復元可能な形でエスケープします。
全テーブルを同じrepeatable-readスナップショットで取得し、完了したダンプだけを `latest.txt` で指します。
過去のスナップショットは残します。特定のスナップショットディレクトリを直接指定することもできます。

復元前に `npm run db:migrate` が必要です。Drizzle自身のマイグレーション履歴はデータダンプ対象外です。
復元はmanifestのテーブル一覧・チェックサムを確認し、親→子の順で全テーブルを一括入力します。
1トランザクションで実行し、途中失敗時は全体をロールバックします。既存データがあるDBは通常拒否します。
シーケンスの復元にはトランザクション対応の `ALTER SEQUENCE ... RESTART WITH` を使います。
`--replace` はアプリ用6テーブルのデータを置き換えます。復元先DBの接続設定を確認して使用してください。
復元・マイグレーション中は、このツールのメール処理・登録と同時に実行できないロックを取得します。

SQLは信頼できる自分のダンプだけを入力してください。チェックサムは事故検知用で署名ではありません。
本文・予定を含むため `db/dumps/` は既定でGit管理対象外です。

## GitHub Actions

DB用Secretやパスワードの設定は不要です。Runnerでもローカルと同じ既定接続先を使います。
Yahooメール・Google OAuthのSecretsだけを設定してください。
PostgreSQL公式イメージの `POSTGRES_HOST_AUTH_METHOD=trust` と、共通の `docker/postgres/pg_hba.conf` を使用します。
既存の名前付きボリュームを使う場合も、この認証設定が適用されます。データの初期化は不要です。
接続用ポートは `127.0.0.1` のみで公開します。
参考: [PostgreSQL公式イメージの認証設定](https://hub.docker.com/_/postgres)。

ワークフローはローカルと同じ `npm run task db:setup` を実行し、同じ `compose.yml` でPostgreSQLを起動します。
起動・ヘルスチェック→未適用マイグレーション→ダンプがあれば復元→選別・照合→SQLダンプ→Compose停止の順です。
ワークフローの `services:` に別のDB定義を持たせず、イメージ・ポート・ボリューム・ヘルスチェックをComposeに集約しています。

RunnerのUbuntuと、`postgres:17-alpine` のAlpineは一致させる必要がありません。
UbuntuのDocker上でAlpineベースのLinuxコンテナーを動かせるため、`compose.yml` はそのまま利用できます。
参考: [Dockerのコンテナーの仕組み](https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/)、
[GitHubのLinux RunnerとDocker](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)。

Runner内のDBとファイルはジョブ終了後に引き継がれません。継続運用にはダンプの永続保存と次回の取得が必要です。
保存先が決まるまでは、自動コミットやArtifactsへの自動アップロードは行いません。
非公開リポジトリへの保存、Artifacts、外部ストレージ等、選択した保存先から `db/dumps/` を取得するステップを追加します。
Artifactsは保存期限があるため、停止期間を含む永久保存先にはなりません。
認証情報はSQLへ保存せず、Yahoo/GoogleのSecretsは従来どおり別管理します。

## コマンド一覧

| コマンド                                  | 用途                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `npm run task db:setup`                   | 起動・マイグレーション                           |
| `npm run db:up`                           | Docker起動・ヘルスチェック待ち                   |
| `npm run db:stop` / `npm run db:down`     | 停止／コンテナー削除。名前付きボリュームは維持   |
| `npm run db:logs`                         | PostgreSQLログ                                   |
| `npm run db:generate`                     | スキーマ変更からSQLマイグレーション生成          |
| `npm run db:migrate`                      | SQLマイグレーション適用                          |
| `npm run db:studio`                       | ローカルでDrizzle Studioを起動                   |
| `npm run db:status`                       | 確認位置・失敗数・実行履歴                       |
| `npm run db:holds` / `npm run db:reviews` | カレンダー保留／メール判定の要確認一覧           |
| `npm run db:resolve -- ...`               | 手動判断の記録・解除                             |
| `npm run db:dump` / `npm run db:restore`  | SQL出力／一括復元                                |
| `npm run task db:import`                  | DB起動・マイグレーション・復元                   |
| `npm run test:db`                         | 実PostgreSQLによる統合テスト。専用の一時DBで実行 |

単一操作はpackage.json、複数操作のまとめだけをTaskfileに定義しています。
ORMとマイグレーションの基礎は [Drizzle公式ドキュメント](https://orm.drizzle.team/docs/get-started/postgresql-new) を参照してください。
