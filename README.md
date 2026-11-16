# auto-calender-register

Yahoo! JAPANメールから予定を抽出し、Googleカレンダーに登録するためのプロジェクトです。
現在は第1段階として、**メールの接続確認・一覧取得・本文取得だけ**を実装しています。
カレンダー登録、定期実行、LLM呼び出しはまだ実装していません。

## セットアップ

Node.js 22以上とnpmが必要です。

```sh
npm ci
```

`.env.example` を `.env` にコピーし、次の2項目をローカルで設定してください。
既に `.env` が存在する場合は上書きしないでください。

```dotenv
YAHOO_IMAP_USER=あなたのYahoo!JAPAN_ID
YAHOO_IMAP_PASSWORD=あなたのパスワード
```

認証情報をチャットやGitに貼り付ける必要はありません。`.env` はGitの追跡対象外です。
シェルなどに同名の環境変数がある場合、そちらが優先されます。

Yahoo!メールの「設定」→「IMAP/POP/SMTPアクセス」で、Yahoo! JAPAN公式サービス以外からのアクセスを許可し、IMAPを有効にしてください。
認証にはYahoo! JAPANの公式設定に従ったIDとパスワードが必要です。
接続先は `imap.mail.yahoo.co.jp:993`、TLSを必須としています。
海外版Yahoo Mailのアプリパスワード設定とは異なります。

公式手順: [Yahoo! JAPAN メールソフトで送受信するには](https://support.yahoo-net.jp/PccMail/s/article/H000007321)

## 順番に実行

以下はPowerShellでもそのまま実行できます。

```sh
# 1. 接続確認: メールボックス名・UIDVALIDITY・メール総数
node --import tsx src/cli.ts check

# 2. 最新10件の一覧: UID・件名・送信者・宛先・日時・既読フラグ・サイズ
node --import tsx src/cli.ts list --limit 10

# 3. 一覧に表示されたUIDを指定して本文を取得（123は置き換える）
node --import tsx src/cli.ts show 123

# 4. 最新3件の一覧と本文を順に取得
node --import tsx src/cli.ts inspect --limit 3
```

出力はJSONです。`inspect` は一覧に続けてメールごとのJSONを出力するため、出力全体は単一のJSON文書ではありません。
本文には個人情報が含まれるため、現段階の本文表示コマンドはローカルで実行してください。
IMAPを読み取り専用で開き、既読フラグの変更・送信・削除は行いません。
一覧はIMAPの受信順で新しいものから取得します（メール本文の予定日時やDateヘッダー順ではありません）。

全コマンドで `--mailbox INBOX` を指定できます。省略時は環境変数 `YAHOO_IMAP_MAILBOX`、未設定なら `INBOX` です。
UIDはメールボックス内の識別子です。将来の永続化ではアカウント・メールボックス・UIDVALIDITY・UIDを組み合わせて管理します。

本文取得はMIMEを解析し、日本語件名・本文を復号します。HTMLだけのメールもテキストに変換します。
添付ファイルはファイル名・種別・サイズのみ表示し、保存しません。
取得時は添付を含むメール全体をメモリに読み込むため、1件あたり10MiBまでに制限しています。
必要な場合は `show` / `inspect` に `--max-bytes 20971520` などを指定できます。
大きすぎるメールや取得失敗があれば非ゼロで終了し、後続処理を止めます。
日時出力はUTCのISO形式です。これはメールの送信日時等の表示であり、予定日時の推定はまだ行いません。

## Taskfileで順次実行

`@go-task/cli` を開発依存としてインストールしています。
公式Taskのnpm配布パッケージで、実際のタスク実行エンジンはGo製です。
最新パッケージのインストーラー依存に監査警告があったため、監査が通る `3.45.4` を固定しています。

```sh
# タスク一覧
npm run task

# 接続確認 → 最新10件の一覧 → 最新3件の本文（順次実行）
npm run task mail:review

# 個別実行
npm run task check
npm run task list
npm run task inspect

# 型チェック → テスト
npm run task verify
```

`Taskfile.yml` の `cmds` に定義した順で実行し、途中で失敗したら停止します。
動的な引数を付ける本文確認は上記の `node --import tsx ... show 123` が簡単です。
npm経由なら `npm run cli -- show 123` でも実行できます。
PowerShellでnpmへのオプション転送がうまくいかない場合は `npm.cmd run cli -- list --limit 5` のように `npm.cmd` を使ってください。

## 今後の実装方針

1. 実メールの形式を確認する（現在の段階）。
2. ICS添付・予約確認など、構造化された情報や対象を絞ったルールから予定候補を抽出する。
3. 明示されたタイムゾーン・UTCオフセットを解釈し、実行時点より未来の開始日時だけを候補にする。日時や地域が不明な場合は自動登録しない。
4. Googleカレンダーを参照し、既存予定との照合と再実行時の重複防止を実装する。メールのMessage-IDだけでは、別メールで通知された同じ予定を判定できないため、ICSのUIDや正規化した予定情報も使う。
5. dry-runで登録候補を検証後、実際の登録と定期実行を追加する。
6. ルールで扱えない文章が必要になった場合に、Ollamaを使うか判断する。

一般的な自由文からの予定判定を、ルールだけで常に正しく行うことはできません。
LLMを使用しても、曖昧な日時やタイムゾーンを確定できるとは限らないため、登録前の検証は必要です。
現時点では対象メールの実例が未確認なので、モデルの導入・選定は保留しています。
将来GitHub-hosted runnerでOllamaを使う場合は、CPU・メモリ・実行時間に収まる量子化モデルを日本語メールの実例で比較します。
GitHub-hosted runnerから手元のOllamaには直接接続できないため、runner上でOllamaとモデルを起動する構成になります。

## 無料運用と実行先

最初はローカル実行が適しています。既存PCで追加のサービス利用料なしに動かせますが、定期実行にはPCの稼働と電力が必要です。

GitHub Actionsは公開リポジトリの標準hosted runnerで無料、非公開リポジトリは契約ごとの無料枠内で運用する必要があります。
将来使う場合は、実測した1回あたりの時間から頻度を決め、超過課金を許可しない設定で運用してください。
今回のメール本文出力を、そのまま公開Actionsのログに流す構成にはしません。
GitHub Actionsのスケジュール実行は指定時刻ぴったりの実行を保証するものではありません。

Cloudflare Workersは今のNode.js CLIをそのまま動かす対象ではなく、採用時にIMAP/TLS対応と無料枠を検証し、実行部分を別途実装します。
ローカルLLMが必要なら、まずローカルまたはGitHub Actionsを候補にします。

外部サービスの将来の料金や無料枠は保証できないため、「永久に完全無料」は保証できません。
有料APIや有料LLMには依存せず、実行先の無料枠内で止められる構成を目指します。

参考: [GitHub Actionsの課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[Actionsの制限](https://docs.github.com/en/actions/reference/limits)、[Taskのインストール](https://taskfile.dev/docs/installation)
