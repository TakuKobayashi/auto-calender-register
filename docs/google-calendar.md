# Googleカレンダー連携

## 初回設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを選択または作成します。
2. 「APIとサービス」で **Google Calendar API** を有効にします。
3. 「Google Auth Platform」でアプリ名・連絡先・対象ユーザーを設定します。外部アプリのテスト中は、使用するGoogleアカウントをテストユーザーに追加します。
4. データアクセスに `https://www.googleapis.com/auth/calendar.events` を追加します。
5. OAuthクライアントを **デスクトップアプリ** として作成します。
6. クライアントIDとクライアントシークレットを `.env` に設定します。

```dotenv
GOOGLE_CLIENT_ID=取得したクライアントID
GOOGLE_CLIENT_SECRET=取得したクライアントシークレット
```

設定後、ローカルで認証します。

```powershell
npm run auth:login
npm run auth:status
```

ブラウザーでGoogleアカウントにログインし、カレンダーへのアクセスを許可します。
ブラウザーとCLIは同じPCで実行してください。認証の待ち時間は5分です。
認証情報は `.secrets/google-oauth.json` に保存されます。

ダウンロードしたクライアントJSONを使う場合:

```powershell
npm run auth:login -- --client-file .secrets/google-client.json
```

クライアント情報の優先順位は `--client-file` → `.env` の2項目 → `.secrets/google-client.json` です。
保存先の変更は `--auth-file`、ブラウザーの手動起動は `--no-browser` を指定します。

外部アプリが「テスト」状態の場合、このスコープのリフレッシュトークンは7日で失効します。
定期運用では公開状態と審査要件を確認し、設定後に再認証してください。
トークン失効時は `auth:login` を実行し、GitHub Secretsも更新します。
[Google OAuthトークンの失効条件](https://developers.google.com/identity/protocols/oauth2#expiration)

## 取得・選別・登録

Docker DesktopとOllamaを起動し、`qwen3.5:9b` を取得してから実行します。

```powershell
npm run task db:setup
npm run task calendar:sync
```

メール取得 → LLMで選別 → ICS出力 → Googleの既存予定と照合・登録 → SQLダンプを実行します。
初回の取得開始日は先月初日、登録先は `primary`（認証したアカウントのメインカレンダー）です。

```powershell
npm run task calendar:sync SINCE=2026-11-01 CALENDAR_ID=YOUR_CALENDAR_ID MODEL=qwen3.5:9b

# 受信箱とShoppingフォルダーを対象に実行
npm run task calendar:sync MAILBOX=INBOX,Shopping
```

別カレンダーのIDは、Googleカレンダーの「設定」→対象カレンダー→「カレンダーの統合」で確認します。
認証したユーザーに登録先への書き込み権限が必要です。

## 個別実行

```powershell
# 取得・選別
npm run calendar:dry-run -- --since 2026-11-01 --ollama-model qwen3.5:9b

# 別フォルダーを選別
npm run calendar:dry-run -- --mailbox INBOX Shopping --ollama-model qwen3.5:9b

# 既存予定と照合（書き込みなし）
npm run calendar:plan -- --report reports/dry-run.json

# 選別済み候補を登録
npm run calendar:register -- --report reports/dry-run.json

# 登録先・結果ファイルを指定
npm run calendar:register -- --calendar-id YOUR_CALENDAR_ID --output reports/another-sync.json
```

登録には完了済みの選別レポートが必要です。登録前にメールを再取得・選別し、後続の変更・取消を反映してください。
現在の処理は新規登録のみです。既存予定の更新・削除、参加者への招待通知は行いません。

## 既存予定との照合

Google APIから全ページと繰り返し予定のインスタンスを取得し、次を照合します。

- 予定キー・固定GoogleイベントID・ICS UID
- 予約などの参照番号と予定日
- 正規化した予定名・開始日時
- 類似する予定名・近接する開始日時・場所

一致・重複疑いは登録対象外にし、理由を結果ファイルとDBに保存します。
このツールで登録後に削除された予定も登録対象外です。
別ツールとの同時登録は競合する場合があるため、自動登録元は一つにしてください。

結果は `reports/calendar-sync.json` に保存します。`calendarWrites` は今回作成した件数です。
API処理の失敗は非ゼロ終了します。

## ICS出力

```powershell
npm run calendar:ics -- --report reports/dry-run.json --output reports/events.ics
```

OAuth認証なしで出力できます。日時付き予定はUTC、終日予定は日付形式です。
ICS出力はGoogleの既存予定との照合を含みません。取り込み時の重複処理は取り込み先アプリの仕様によります。

## GitHub Actions

「Settings → Secrets and variables → Actions → New repository secret」で、ローカルの `.env` と同じ名前・値を登録します。

| Secret                 | 内容                                    |
| ---------------------- | --------------------------------------- |
| `YAHOO_IMAP_USER`      | Yahoo! JAPAN ID                         |
| `YAHOO_IMAP_PASSWORD`  | Yahoo!メールのIMAP用パスワード          |
| `GOOGLE_CLIENT_ID`     | デスクトップアプリ用OAuthクライアントID |
| `GOOGLE_CLIENT_SECRET` | 同じOAuthクライアントのシークレット     |
| `GOOGLE_REFRESH_TOKEN` | ローカル認証済みのリフレッシュトークン  |

[calendar.yml](../.github/workflows/calendar.yml) はデフォルトブランチで毎日 **01:00・09:00・17:00（日本時間）** にメールを確認し、確定予定を登録します。手動確認は **Actions → Mail calendar → Run workflow** から実行できます。

| 入力      | 内容                                                                            |
| --------- | ------------------------------------------------------------------------------- |
| `since`   | 受信開始日                                                                      |
| `apply`   | `true` で登録、既定は `false`（照合のみ）                                       |
| `model`   | Ollamaモデル。既定は `qwen3.5:9b`、空欄はルール方式                             |
| `mailbox` | 対象フォルダー。省略時はリポジトリ変数 `YAHOO_IMAP_MAILBOX`、未設定なら `INBOX` |

定期実行のモデルはリポジトリ変数 `OLLAMA_MODEL` で変更できます。既定は `qwen3.5:9b` です。Ollama本体・モデル・npmのダウンロードを再利用します。

登録先は認証したGoogleアカウントのメインカレンダーです。SQLダンプの確認・取得は [Artifactsのダウンロード手順](database.md#github-actions) を参照してください。

Actionsでは `--no-mail-details` を指定し、コンソールには件数と実行状況を表示します。ローカルでは既定で詳細を表示し、`calendar:dry-run`、`calendar:plan`、`calendar:register`、`calendar:ics` に同じオプションを指定できます。
