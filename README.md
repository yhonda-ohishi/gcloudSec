# @yhonda/gcloud-secrets-mcp

複数の GCP プロジェクトの `.env` / `.dev.vars` を1つの Secret Manager で一元管理する CLI ツール。

Claude Code のスキルとしても利用可能。

## 概要

```
Secret Manager (中央プロジェクト)
├── project-a/
│   ├── DATABASE_URL
│   ├── API_KEY
│   └── CLOUDFLARE_SECRET
├── project-b/
│   ├── DATABASE_URL
│   └── STRIPE_KEY
└── project-c/
    └── ...
```

## インストール

```bash
# ~/bin にインストール
mkdir -p ~/bin && cd ~/bin
npm install @yhonda/gcloud-secrets-mcp
ln -sf ~/bin/node_modules/.bin/gcloud-secrets-mcp ~/bin/gcloud-secrets-mcp

# PATH に追加 (~/.bashrc または ~/.zshrc)
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
```

### 前提条件

- Node.js 18 以上
- GCP 認証済み（`gcloud auth application-default login`）

## 初期設定

```bash
gcloud-secrets-mcp init <project-id>
```

設定は `~/.secrets-manager.conf` に保存されます。

## CLI 使い方

```bash
# フォルダ一覧
gcloud-secrets-mcp list

# フォルダ内のシークレット一覧
gcloud-secrets-mcp list my-project

# シークレットを取得（.env形式で標準出力）
gcloud-secrets-mcp pull my-project

# シークレットをアップロード
gcloud-secrets-mcp push my-project .env
```

## Claude Code スキル

`~/.claude/commands/secrets.md` を作成すると `/secrets` コマンドが使えます:

```markdown
# GCP Secret Manager スキル

ユーザーの指示に従って以下のコマンドを実行:

- `~/bin/gcloud-secrets-mcp list` - フォルダ一覧
- `~/bin/gcloud-secrets-mcp list <folder>` - シークレット一覧
- `~/bin/gcloud-secrets-mcp pull <folder>` - 取得
- `~/bin/gcloud-secrets-mcp push <folder> <file>` - アップロード
```

### 使用例

Claude に以下のように依頼できます:

- `/secrets list`
- `/secrets pull my-project`
- 「このプロジェクトの .env を Secret Manager にアップロードして」

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `init <project-id>` | 中央プロジェクトを設定 |
| `list [folder]` | 一覧表示 |
| `pull [folder]` | シークレットを取得 |
| `push [folder] [file]` | アップロード |

## 設定

環境変数または設定ファイルで中央プロジェクトを指定:

```bash
# 環境変数
export SECRETS_CENTRAL_PROJECT=your-project-id

# または設定ファイル (~/.secrets-manager.conf)
SECRETS_CENTRAL_PROJECT=your-project-id
```

## ライセンス

MIT
