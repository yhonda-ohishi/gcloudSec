# @yhonda/gcloud-secrets

複数の GCP プロジェクトの `.env` / `.dev.vars` を1つの Secret Manager で一元管理する CLI ツール。

Claude Code のスキルとしても利用可能。

## 概要

```
Secret Manager (中央プロジェクト)
├── project-a/ [dev]
│   ├── DATABASE_URL
│   ├── API_KEY
│   └── CLOUDFLARE_SECRET
├── project-a/ [prod]
│   ├── DATABASE_URL
│   └── API_KEY
├── project-b/ [dev]
│   ├── DATABASE_URL
│   └── STRIPE_KEY
└── project-c/
    └── ...
```

## インストール

```bash
npm install -g @yhonda/gcloud-secrets
```

### 前提条件

- Node.js 18 以上
- GCP 認証済み（`gcloud auth application-default login`）

## 初期設定

```bash
gcloud-secrets init <project-id> [--env <default-env>]
```

設定は `~/.secrets-manager.conf` に保存されます。

## CLI コマンド

### 基本操作

```bash
# フォルダ一覧（環境ごとにグループ化）
gcloud-secrets list

# フォルダ内のシークレット一覧
gcloud-secrets list my-project --env dev

# シークレットを取得（.env 形式で標準出力）
gcloud-secrets pull my-project --env prod

# シークレットをアップロード
gcloud-secrets push my-project .env --env dev
```

### スキャン & 検索

```bash
# 全リポジトリの .env 同期状況をスキャン
gcloud-secrets scan

# 指定パス以下をスキャン（特定環境のみ）
gcloud-secrets scan ~/projects --env dev

# 値から逆引き検索
gcloud-secrets search "api-key-12345"
```

### 自動同期 (pre-commit hook)

```bash
# グローバル git hook をインストール（全リポジトリ対象）
gcloud-secrets hook install

# アンインストール
gcloud-secrets hook uninstall

# 手動実行
gcloud-secrets pre-commit
```

`hook install` すると、全リポジトリで `git commit` のたびに `.env` が自動で Secret Manager に同期されます。

**高速化の仕組み:**
- キャッシュ (`~/.secrets-manager-cache.json`) で .env の変更を検知
- 変更なし → **0 API コール**（即座に終了）
- 変更あり → フィルタ付き API + 並列取得で高速チェック＆自動 push
- 常に exit 0（commit をブロックしない）
- 既存の `.husky/` や `.git/hooks/` と互換性あり

## 環境 (Environment)

`--env` または `-e` で環境を指定できます:

```bash
gcloud-secrets push --env dev     # dev 環境にアップロード
gcloud-secrets pull -e prod       # prod 環境から取得
gcloud-secrets scan --env staging # staging のみスキャン
```

デフォルト環境は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT` で設定。

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `init <project-id> [--env <default>]` | 中央プロジェクトを設定 |
| `list [folder] [--env <env>]` | 一覧表示 |
| `pull [folder] [--env <env>]` | シークレットを取得 |
| `push [folder] [file] [--env <env>]` | アップロード |
| `scan [basePath] [--env <env>]` | Git リポジトリの同期状況をスキャン |
| `search <keyword> [--env <env>]` | 値から逆引き検索 |
| `pre-commit` | .env 自動同期（git hook 用） |
| `hook install` | グローバル git hook をインストール |
| `hook uninstall` | グローバル git hook をアンインストール |

## フォルダ名の正規化

ディレクトリ名は自動で kebab-case に変換されます:

- `gcloudSec` → `gcloud-sec`
- `myAppTest` → `my-app-test`

## シークレット名の形式

`{folder}_{env}_{KEY}` (例: `gcloud-sec_dev_DATABASE_URL`)

## 設定

環境変数または設定ファイルで中央プロジェクトを指定:

```bash
# 環境変数
export SECRETS_CENTRAL_PROJECT=your-project-id

# または設定ファイル (~/.secrets-manager.conf)
SECRETS_CENTRAL_PROJECT=your-project-id
DEFAULT_ENVIRONMENT=dev
```

## Claude Code スキル

インストール時に `~/.claude/skills/secrets.md` が自動作成され、`/secrets` コマンドが使えます:

- 「このプロジェクトの .env を Secret Manager にアップロードして」
- 「dev 環境のシークレットを確認して」
- 「全リポジトリの同期状況をスキャンして」

## ライセンス

MIT
