# auto-calender-register

Yahoo! JAPANメールから確定予定・対応期限を選別し、既存予定との重複を確認してGoogleカレンダーに登録するCLIです。ICSファイルにも出力できます。

## セットアップ

必要なもの:

- Node.js 22以上
- Docker Desktop
- Ollamaとローカルモデル `qwen3.5:9b`
- GoogleカレンダーのOAuth認証情報

```sh
npm ci
ollama pull qwen3.5:9b
```

`.env.example` を `.env` にコピーし、Yahoo! JAPANメールの認証情報を設定します。

```dotenv
YAHOO_IMAP_USER=あなたのYahoo!JAPAN_ID
YAHOO_IMAP_PASSWORD=あなたのパスワード
```

Yahoo!メールの「設定」→「IMAP/POP/SMTPアクセス」で、外部メールソフトからのアクセスとIMAPを有効にします。
[Yahoo! JAPANの設定手順](https://support.yahoo-net.jp/PccMail/s/article/H000007321)

Docker DesktopとOllamaを起動し、DBの準備とGoogleの初回認証を行います。
OAuth認証情報の設定は [Googleカレンダー連携](docs/google-calendar.md) を参照してください。

```sh
npm run task db:setup
npm run auth:login
```

## メール取得からカレンダー登録まで

```sh
npm run task calendar:sync
```

メール取得 → ローカルLLMで選別 → ICS出力 → Googleの既存予定と照合・登録 → SQLダンプを順に実行します。

初回は先月初日以降の受信メールを対象にし、以降はDBに保存した開始日を維持します。登録先はメインカレンダーです。
期間・登録先・モデルを指定する場合:

```sh
npm run task calendar:sync SINCE=2026-10-01 CALENDAR_ID=primary MODEL=qwen3.5:9b
```

既定の対象は受信箱（`INBOX`）です。複数フォルダーはカンマ区切りで指定します。

```sh
npm run task calendar:sync MAILBOX=INBOX,Shopping
```

未確定・完了・取消・過去の予定、広告、既存予定と重複するものは登録しません。
時刻のない期限は終日表示、終了時刻のない確定予定は開始通知用の15分枠になります。
件名・本文・ICSから今後の日時候補を探します。「明日」などの相対日付はメールの日付を基準に解釈し、末尾の署名や配信停止欄を日時候補の検索から外します。残ったメールが本人の予定や対応期限かはLLMが判定します。省略件数は選別結果に表示します。
販促・一斉配信の一般案内・未申込者向け募集も事前に除外します。予約成立や注文の手掛かりがあるメール、ICS付きメールはこの除外の対象外です。
未判定のメールは最大3通ずつOllamaに渡します。実行ログに本文の再利用件数、選別結果に判定キャッシュの利用件数とOllamaへの呼び出し回数を表示します。
登録済み予定の更新・削除には対応していません。

## 登録せずに確認

```sh
# メールを取得・選別
npm run calendar:dry-run -- --since 2026-10-01 --ollama-model qwen3.5:9b

# Googleの既存予定と照合（書き込みなし）
npm run calendar:plan

# 選別済みの候補をICSに出力
npm run calendar:ics
```

結果は `reports/` に保存します。

| ファイル             | 内容                                     |
| -------------------- | ---------------------------------------- |
| `dry-run.md`         | 送信元・件名・登録対象かどうか・判定理由 |
| `dry-run.json`       | 選別結果と予定データ                     |
| `calendar-sync.json` | 既存予定との照合・登録結果               |
| `events.ics`         | カレンダー取り込み用ファイル             |
| `mail-cache.json`    | 取得済みメール                           |

## メールの接続・本文確認

```sh
npm run mail:check
npm run mail:list -- --limit 10
npm run mail:show -- 123
npm run task mail:review
```

`123` は一覧に表示されたUIDに置き換えます。
一覧・本文確認の既定フォルダーは `YAHOO_IMAP_MAILBOX`、未設定なら `INBOX` です。
メールは読み取り専用で取得します。

## DB・定期実行

```sh
npm run db:status
npm run db:decisions
npm run db:dump
npm run db:restore
```

- [DBの保存内容・SQLダンプと復元](docs/database.md)
- [OAuth・Googleカレンダー・GitHub Actionsの設定](docs/google-calendar.md)

## 開発

```sh
npm run format
npm run task verify
npm run test:db
```
