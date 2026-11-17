# Googleカレンダー登録・ICS出力

完了済みの `reports/dry-run.json` を読み、`candidate` だけを処理します。
`pending`、`review`、解析エラーのある未完了レポートは登録しません。
開始日時が実行時点以前になった予定も再確認して除外します。

## 最初に使うコマンド

**OAuth認証後は、次の1コマンドでメール取得・選別からGoogle登録まで進みます。**

初回はDocker Desktopを起動し、`npm run task db:setup` でDBを準備してください。

```powershell
npm run task calendar:sync
```

Ollamaの起動と `qwen3.5:9b` の取得を済ませてください。
接続確認→未取得本文を取得→LLMで選別（抽出キャッシュを再利用）→ICS生成→Googleの既存予定と照合→新規登録→SQLダンプの順です。
初回に日付指定がなければ先月初日以降を対象とし、以降はDBの開始日を維持します。カレンダー指定がなければ `primary` へ登録します。
未確定・根拠不足・既存予定は登録せず、途中の処理が失敗した場合は停止します。
多数のメールを対象にするとLLMの処理に時間がかかります。

期間・登録先・モデルはTaskの引数で指定できます。環境変数にカレンダーIDを設定する必要はありません。

```powershell
npm run task calendar:sync SINCE=2026-11-01 CALENDAR_ID=YOUR_CALENDAR_ID MODEL=qwen3.5:9b
```

以下は、初回認証や、各処理だけを個別に実行する場合のコマンドです。

```powershell
# OAuth不要: 他のカレンダーに取り込めるICSへ出力
npm run calendar:ics

# 以下は初回のOAuth設定後
npm run auth:login
npm run auth:status

# Googleカレンダーの既存予定と照合するだけ（書き込み0件）
npm run calendar:plan

# 既に選別済みの候補だけを登録（メールの再取得・再選別はしない）
npm run calendar:register
```

古い選別ファイルには、後から届いた変更・キャンセルが反映されません。
実際の登録前にはメールの取得・選別を更新してください。
現在は新規登録だけを行い、登録済み予定の日時変更・削除はしません。

## Google側の初回設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを選択または作成します。
2. 「APIとサービス」で **Google Calendar API** を有効にします。
3. 「Google Auth Platform」でアプリ名・連絡先等を設定します。個人のGmailで使う場合は外部ユーザー向けに設定し、テスト段階では自分のGoogleアカウントをテストユーザーへ追加します。
4. データアクセスのスコープに `https://www.googleapis.com/auth/calendar.events` を設定します。メール送信やGmail本文を読む権限は使いません。
5. 「クライアント」からOAuthクライアントを作成し、アプリケーションの種類を **デスクトップアプリ** にします。Webアプリ用ではありません。
6. クライアントIDとクライアントシークレットを `.env` の `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に設定します。または、ダウンロードしたJSONを `.secrets/google-client.json` に保存します。

`.secrets` フォルダーは必要に応じて作成してください。OAuthクライアントJSONやトークンをチャット・Gitへ貼り付ける必要はありません。
公式の [Calendar API Node.jsクイックスタート](https://developers.google.com/workspace/calendar/api/quickstart/nodejs) にもAPI有効化とデスクトップクライアント作成の手順があります。

## ローカルでOAuthを完了する

`.env` にデスクトップアプリ用OAuthクライアントの情報を設定した場合は、JSONファイルなしで実行できます。

```dotenv
GOOGLE_CLIENT_ID=取得したクライアントID
GOOGLE_CLIENT_SECRET=取得したクライアントシークレット
```

初回認証に `GOOGLE_REFRESH_TOKEN` は不要です。未設定・空欄にしてください。
`--client-file` を明示した場合はそのファイルを優先し、省略時は上記2環境変数、次に `.secrets/google-client.json` を使います。

```powershell
npm run auth:login
```

ブラウザーが開くので、登録先のGoogleアカウントでログインし、カレンダーの予定へのアクセスを許可します。
ターミナルに保存完了が出たら終了です。リフレッシュトークンは `.secrets/google-oauth.json` に保存され、画面には表示しません。

認証には、一時ポートの `127.0.0.1` コールバック・PKCE・stateを使います。
ブラウザーとCLIは同じPCで実行してください。GitHub Actionsで `auth login` を実行する必要はありません。
自動でブラウザーを開きたくない場合は `auth login --no-browser` を指定して、表示されたURLを同じPCのブラウザーで開きます。
待ち時間は5分です。

別のファイルを使う場合:

```powershell
npm run auth:login -- --client-file .secrets/my-client.json --auth-file .secrets/my-auth.json
npm run auth:status -- --auth-file .secrets/my-auth.json
```

保存されるのは、バージョン・クライアントID・クライアントシークレット・リフレッシュトークン等です。
短命なアクセストークンは保存せず、Googleの公式認証ライブラリが実行時に取得・更新します。

**外部アプリが「テスト」状態の場合、今回のスコープのリフレッシュトークンは7日で失効します。**
長期運用ではGoogle Auth Platformの公開状態・必要な審査要件を確認し、本番運用の設定後に再認証してください。
本番でもユーザーによる許可取り消し等で失効することはあります。その場合は `auth login` を再実行し、Secretsも更新します。
出典: [Google OAuthトークンの失効条件](https://developers.google.com/identity/protocols/oauth2#expiration)。

## 登録先と実際の登録

標準の `primary` は、OAuthで認証したGoogleアカウントのメインカレンダーです。
別カレンダーへ登録する場合は、Googleカレンダーの「設定」→対象カレンダー→「カレンダーの統合」でIDを確認し、
`--calendar-id` 引数で指定します。省略時は `primary` へ登録でき、環境変数での設定は不要です。
認証したユーザーに書き込み権限が必要です。

```powershell
# オンラインで重複確認。作成予定・既存・重複疑いを reports/calendar-sync.json に保存
npm run calendar:plan -- --report reports/dry-run.json

# 実際に登録。確認プロンプトはなく、--applyの指定で書き込みます
npm run calendar:register -- --report reports/dry-run.json

# 別カレンダー・別の結果ファイル
npm run calendar:register -- --calendar-id 'YOUR_CALENDAR_ID' --output reports/another-sync.json
```

照合は毎回Google APIから最新の予定を取得し、全ページと繰り返し予定のインスタンスを対象にします。

- このツールが付けた予定キー、または固定のGoogleイベントIDが一致すれば追加しません。
- ICSのUIDが一致する予定も追加しません。
- 件名とUTC開始日時が一致するGrokbot・手動登録の予定も追加しません。
- 同時刻でタイトルが違う場合や、似た予定の時刻が近い場合は `possible_duplicate` として保留します。自動で強制追加しません。
- このツールが以前登録し、カレンダー側で削除された予定は自動で復活させません。
- APIが409（競合）を返したら同じイベントIDを照合し直します。通信失敗後の再実行も同じIDを使います。

意味の異なるタイトルや、大きく変更された日時を完全に同一予定と判断できる保証はありません。
Grokbotとの並行登録をGoogle側で一つのトランザクションにはできないため、両方が同時に新規作成する競合は完全には防げません。
移行後に二重の自動登録を避けるには、運用する登録元を決めてください。

参加者の招待・通知メールは送信しません。予定の更新・削除も行いません。
エラー時の終了コードは非ゼロです。重複疑いの保留は結果ファイルとDBへ記録し、他の予定は続行します。
保留だけなら既定では終了コード0です。保留も終了コード2にする場合は `--fail-on-hold` を指定します。
保留の再照合と手動判断、DBの準備は [データベース運用](database.md) を参照してください。
`calendarWrites` は実際に今回作成できた件数で、処理途中の結果も1件ごとに保存します。

## ICSとして出力する

```powershell
npm run calendar:ics -- --report reports/dry-run.json --output reports/events.ics
```

OAuthなしで使えます。Appleカレンダー、Outlookなど、ICSに対応するアプリで取り込めます。
UIDは同じ予定に対して安定し、日時はUTCで保存します。日本語・改行のエスケープとUTF-8の75バイト折り返しに対応します。
元のICSメールにUIDがある場合はそれを維持します。相手アプリがUIDで重複を扱うかはそのアプリの仕様によります。
このオフライン出力だけではGoogleの既存予定を照合しません。

ICSとAPI登録を併用した場合でも、API側ではICSのUIDや件名・開始日時を照合します。
Googleが新規API登録時に付けるiCalUIDと、オフラインICSのUIDは必ずしも同じではありません。
会議招待としての配信や、既存予定の更新・取消用ファイルの生成は対象外です。

## GitHub Actionsへの認証情報の引き継ぎ

ローカルでOAuthが完了したら、`.secrets/google-oauth.json` のJSON全体を、GitHubのRepository Secret **GOOGLE_OAUTH_JSON** に設定します。
必要なら `auth export` で別のファイルへコピーできます。内容をコンソールに出しません。

```powershell
npm run auth:export

# ghで設定する場合。OWNER/REPOは実際のリポジトリに置き換える
Get-Content -Raw -LiteralPath .secrets/github-google-oauth.json | gh secret set GOOGLE_OAUTH_JSON --repo OWNER/REPO
```

GitHubの画面では「Settings → Secrets and variables → Actions → New repository secret」を使います。

| 種類     | 名前                  | 内容                                |
| -------- | --------------------- | ----------------------------------- |
| Secret   | `YAHOO_IMAP_USER`     | Yahoo! JAPAN ID                     |
| Secret   | `YAHOO_IMAP_PASSWORD` | Yahoo!メールのIMAP用パスワード      |
| Secret   | `GOOGLE_OAUTH_JSON`   | `auth login` で保存した認証JSON全体 |
| Variable | `YAHOO_IMAP_MAILBOX`  | 任意。未設定なら `INBOX`            |

他のSecrets管理サービスでも、実行環境の `GOOGLE_OAUTH_JSON` に同じJSONを渡せば使えます。
代わりに `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` の3環境変数でも渡せます。
通常実行時の優先順位はJSON環境変数→リフレッシュトークンを含む3環境変数→ローカル認証ファイルです。
クライアントID・シークレットだけを `.env` に置いた場合は、`auth:login` が保存したファイルのトークンを使用します。
`.env` のクライアント情報と保存済みファイルが異なる場合は再認証してください。
JSONはBase64ではなく、そのままのJSON文字列を渡します。

公式: [GitHub Actions Secretsの設定](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

## 用意したワークフロー

[.github/workflows/calendar.yml](../.github/workflows/calendar.yml) を追加しています。

1. Node.js・依存関係を準備する。
2. 選択したモデルをrunner内のOllamaへ用意する（モデル名を空欄にした場合はルール方式のみ）。
3. Yahooメールを取得し、選別する。
4. ICSを生成する。
5. Googleの既存予定と照合し、`apply` が有効な場合だけ新規登録する。

初期状態は手動実行 `workflow_dispatch` のみで、`apply` はfalseです。
登録先は実行時の `calendar_id` 入力から `--calendar-id` 引数へ渡します。空欄・省略時は `primary` です。
スケジュール実行時も、引数指定がなければ `primary` へ登録します。
スケジュール運用は、コメントにしてある `schedule` を有効にし、書き込みも有効にする場合は `REGISTER_ON_SCHEDULE` をtrueにします。
スケジュール時は `qwen3.5:9b` を使います。認証のやり直しはrunner上では行いません。
本文・判定詳細・認証ファイルは公開ログやArtifactsにアップロードしません。

CPU runnerでは長い推論に備えて1メール600秒まで待ち、ストリームで応答を受信します。
ジョブ全体は120分です。大量の過去メールの初回処理では、受信期間を絞って実測してください。
現在のワークフローはPostgreSQLを使用します。保存済み本文・LLM抽出結果を再利用し、取得失敗は再試行します。
処理前のSQL一括復元と、終了時のテーブル別SQLダンプにも対応します。
Runner間の引き継ぎには、[SQLダンプの保存先設定](database.md#github-actions) が必要です。
モデルのキャッシュ容量、Actionsの実行時間・無料枠はアカウント全体の利用状況も含めて確認してください。

## 検証

```powershell
npm run task verify
```

Google APIのアダプターを差し替えたテストで、dry-run・登録・再実行・409競合・既存予定・期限切れ等を検証します。
実カレンダーへの接続・登録確認には、利用者のOAuth設定が必要です。
