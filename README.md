# secrets - GitHub clone風 Secret Manager CLI

複数の GCP プロジェクトの `.env` / `.dev.vars` を1つの Secret Manager で一元管理する CLI ツール。

## 概要

```
Secret Manager (中央プロジェクト)
├── project-a/
│   ├── DATABASE_URL
│   ├── API_KEY
│   └── CLOUDFLARE_SECRET   ← 元は .dev.vars
├── project-b/
│   ├── DATABASE_URL
│   └── STRIPE_KEY
└── project-c/
    └── ...
```

## インストール

```bash
# クローン
git clone <this-repo>
cd gcloudSec

# 実行権限付与
chmod +x secrets

# PATH に追加（オプション）
sudo ln -s $(pwd)/secrets /usr/local/bin/secrets
```

### 前提条件

- gcloud CLI がインストール済み
- `gcloud auth login` で認証済み

## 初期設定

```bash
secrets init
# → 中央管理用の GCP プロジェクトID を入力
```

設定は `~/.secrets-manager.conf` に保存されます。

## 使い方

### Push: ローカル → Secret Manager

```bash
# カレントディレクトリの .env または .dev.vars を自動検出
secrets push my-project

# ファイルを指定
secrets push my-project .dev.vars
secrets push my-project .env.local
```

### Pull: Secret Manager → ローカル

```bash
# 標準出力に出力
secrets pull my-project

# ファイルに保存
secrets pull my-project .env
secrets pull my-project .dev.vars

# git clone 風（.env として保存）
secrets clone my-project
```

### 一覧表示

```bash
# フォルダ一覧
secrets list

# フォルダ内のキー一覧
secrets list my-project
```

### 差分確認

```bash
# ローカルとリモートの差分
secrets diff my-project
```

### 削除

```bash
# 特定のキーを削除
secrets delete my-project API_KEY

# フォルダ全体を削除
secrets delete my-project
```

## 利用例

### Cloudflare Workers プロジェクト

```bash
cd ~/projects/my-worker

# .dev.vars をアップロード
secrets push my-worker .dev.vars

# 別マシンで取得
secrets pull my-worker .dev.vars
```

### Node.js / Next.js プロジェクト

```bash
cd ~/projects/my-app

# .env.local をアップロード
secrets push my-app .env.local

# 取得
secrets clone my-app
mv .env .env.local
```

### 複数環境の管理

```bash
# 開発環境
secrets push myapp-dev .env

# 本番環境
secrets push myapp-prod .env.production
```

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `secrets init` | 初期設定 |
| `secrets push <folder> [file]` | アップロード |
| `secrets pull <folder> [file]` | ダウンロード |
| `secrets clone <folder> [dir]` | git clone 風にダウンロード |
| `secrets list [folder]` | 一覧表示 |
| `secrets delete <folder> [key]` | 削除 |
| `secrets diff <folder> [file]` | 差分表示 |

## 設定

環境変数または設定ファイルで中央プロジェクトを指定:

```bash
# 環境変数
export SECRETS_CENTRAL_PROJECT=your-project-id

# または設定ファイル (~/.secrets-manager.conf)
SECRETS_CENTRAL_PROJECT=your-project-id
```

## 他プロジェクトからのアクセス許可

子プロジェクトのサービスアカウントに読み取り権限を付与:

```bash
gcloud secrets add-iam-policy-binding "myapp_DATABASE_URL" \
  --member="serviceAccount:sa@child-project.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=central-project
```

## MCP サーバー (Claude Code 連携)

Claude Code から直接シークレットを操作できます。

### インストール

```bash
cd gcloudSec
npm install
```

### Claude Code に登録

```bash
claude mcp add gcloud-secrets node /root/gcloudSec/mcp-server.js
```

または `~/.claude/settings.json` に直接追加:

```json
{
  "mcpServers": {
    "gcloud-secrets": {
      "command": "node",
      "args": ["/root/gcloudSec/mcp-server.js"]
    }
  }
}
```

### 利用可能なツール

| ツール | 説明 |
|--------|------|
| `secrets_init` | 中央プロジェクトを設定 |
| `secrets_list` | フォルダ/シークレット一覧 |
| `secrets_pull` | シークレットを .env 形式で取得 |
| `secrets_push` | .env 内容をアップロード |
| `secrets_delete` | シークレット削除 |

### 使用例

Claude に以下のように依頼できます:

- 「このプロジェクトの .env を Secret Manager にアップロードして」
- 「my-project のシークレットを取得して」
- 「Secret Manager のフォルダ一覧を見せて」

## ライセンス

MIT
