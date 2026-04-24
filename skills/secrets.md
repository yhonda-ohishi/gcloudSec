# Skill: secrets

Google Drive + age 暗号化でシークレットを管理するスキル

## コマンド一覧

### 初期化
```bash
gcloud-secrets init [drive-folder-id] --client-id <id> --client-secret <secret> [--env <default>]
```
Google Drive + OAuth + age 鍵の初期設定を行います。
- `drive-folder-id` 省略時は Drive に "gcloud-secrets" フォルダを自動作成
- `--client-id` / `--client-secret`: Google Cloud Console で作成した OAuth クライアント情報
- `--env` でデフォルト環境を指定（省略時は `dev`）
- `--age-key <path>` で age 秘密鍵パスを指定（省略時は `~/.age/key.txt`、未作成なら自動生成）
- `--age-pub <key>` で age 公開鍵を指定（省略時は秘密鍵ファイルから自動取得）

### 再認証 (reauth)
```bash
gcloud-secrets reauth
```
OAuth token が失効した (refresh token invalid_grant) 時に、**token だけ** を更新します。
- 既存 config (DRIVE_FOLDER_ID / OAuth client / age 鍵) には一切触れない
- 失効 token は `~/.secrets-manager-oauth.json.stale-<timestamp>` に退避
- **OAuth 2.0 Device Flow** (Tailscale 風) で認証: URL + ユーザーコード表示 → 別デバイスで承認 → CLI は token エンドポイントを poll
- リモート SSH / ヘッドレス環境でも動作 (ローカルブラウザ不要)
- OAuth フロー後に Drive フォルダの read 疎通も確認
- pre-commit hook が `invalid_grant` を検知すると `reauth` の実行を促すメッセージを表示 (commit は blocking しない)

**前提**: `~/.secrets-manager.conf` に以下を追加しておくこと (Google Cloud Console で "TVs and Limited Input devices" タイプの OAuth client を作成):
```
GOOGLE_DEVICE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_DEVICE_CLIENT_SECRET=GOCSPX-xxxxx
```

Init の desktop flow で取った token と device flow で取った token は `_client_type` マーカーで区別され、自動で適切な client 情報で refresh されます。

### 一覧表示
```bash
# フォルダ一覧 (環境ごとにグループ化)
gcloud-secrets list

# 特定フォルダ・環境のシークレット一覧
gcloud-secrets list <folder> --env dev
```

### シークレット取得 (pull)
```bash
# カレントディレクトリ名をフォルダ名として取得
gcloud-secrets pull --env dev

# 指定フォルダから取得
gcloud-secrets pull <folder> --env prod
```
Drive から暗号化ファイルをダウンロードし、age で復号して .env 形式で出力します。

### シークレット登録 (push)
```bash
# .env ファイルをアップロード (dev 環境)
gcloud-secrets push --env dev

# 指定フォルダにアップロード (prod 環境)
gcloud-secrets push <folder> --env prod

# 指定ファイルをアップロード
gcloud-secrets push <folder> <file> --env staging
```
.env ファイルを age で暗号化し、Drive にアップロードします。

### 同期状況スキャン (scan)
```bash
# ホームディレクトリ以下をスキャン (全環境)
gcloud-secrets scan

# 特定環境のみスキャン
gcloud-secrets scan --env dev

# 指定ディレクトリ以下をスキャン
gcloud-secrets scan <path> --env prod
```
Git リポジトリ内の .env / .dev.vars ファイルと Drive 上の暗号化ファイルの同期状況を確認します。

### 値から逆引き検索 (search)
```bash
# 特定の値がどのフォルダ・環境で使われているか検索
gcloud-secrets search "api-key-12345"

# 特定環境のみ検索
gcloud-secrets search "client-id" --env prod
```

出力例:
```
Searching for: "api-key-12345"

Scanning 8 files...

[FOUND] my-app / dev - EXTERNAL_API_KEY
[FOUND] my-app / prod - EXTERNAL_API_KEY
[FOUND] other-service / dev - LINE_CLIENT_ID

Found 3 matches in 2 folders
```

#### scan 出力例:
```
=== シークレット同期状況 ===

[OK]   project-a/ .env [dev] (3 keys)
[DIFF] project-b/ .env [prod] (2 keys) - 差分あり
[NEW]  project-c/ .dev.vars [dev] (5 keys) - 未登録

---
合計: 3 ファイル
  登録済み: 1
  差分あり: 1
  未登録: 1
```

### .env 自動同期 (pre-commit)
```bash
# カレントディレクトリの .env を Drive に自動同期
gcloud-secrets pre-commit
```
git hook 用の高速コマンド。キャッシュで .env の変更を検知し、変更がなければ API コール 0 で即座に終了。
変更があれば Drive からダウンロード＋復号で比較し、差分があれば暗号化＋アップロード。

### グローバル git hook (hook)
```bash
# グローバル pre-commit hook をインストール
gcloud-secrets hook install

# アンインストール
gcloud-secrets hook uninstall
```
`hook install` で全リポジトリの `git commit` 時に `pre-commit` が自動実行されます。
既存の `.husky/` や `.git/hooks/` のフックにもフォワードするので互換性があります。

## 環境 (Environment) オプション

`--env` または `-e` で環境を指定できます:
- `dev` - 開発環境
- `staging` - ステージング環境
- `prod` - 本番環境
- その他任意の文字列

デフォルト環境は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT` で設定されます。

## 使用例

```bash
# 1. 初期化 (OAuth クライアント情報を設定)
gcloud-secrets init --client-id "xxx.apps.googleusercontent.com" --client-secret "GOCSPX-xxx" --env dev

# 2. dev 環境に .env を登録
gcloud-secrets push --env dev

# 3. prod 環境から取得
gcloud-secrets pull --env prod > .env.prod

# 4. 全リポジトリの同期状況を確認
gcloud-secrets scan ~/

# 5. dev 環境のみスキャン
gcloud-secrets scan ~/ --env dev

# 6. 特定の値がどこで使われているか検索
gcloud-secrets search "line-client-id-xxx"

# 7. グローバル git hook をインストール (全リポジトリで自動同期)
gcloud-secrets hook install

# 8. 手動で pre-commit を実行
gcloud-secrets pre-commit
```
