# gcloudSec - GCP Secret Manager CLI

## Overview
GCP Secret Manager を GitHub clone 風に管理する CLI ツール。
`.env` ファイルと Secret Manager を同期管理する。

## Commands
```bash
gcloud-secrets init <project-id> [--env <default>]  # 中央プロジェクトを設定
gcloud-secrets list [folder] [--env <env>]          # フォルダ/シークレット一覧
gcloud-secrets pull [folder] [--env <env>]          # シークレットを .env 形式で取得
gcloud-secrets push [folder] [file] [--env <env>]   # .env をアップロード
gcloud-secrets scan [basePath] [--env <env>]        # Git リポジトリの同期状況をスキャン
gcloud-secrets search <keyword> [--env <env>]  # 値から逆引き検索
gcloud-secrets pre-commit                      # .env 自動同期 (git hook 用)
gcloud-secrets hook install                    # グローバル git hook インストール
gcloud-secrets hook uninstall                  # グローバル git hook アンインストール
```

## Key Concepts

### Environment (環境)
`--env` または `-e` で環境を指定できる:
- `gcloud-secrets push --env dev` → dev 環境にアップロード
- `gcloud-secrets pull -e prod` → prod 環境から取得
- デフォルト環境は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT` で設定

### Folder Naming
フォルダ名は自動で正規化される (camelCase → kebab-case):
- `gcloudSec` → `gcloud-sec`
- `myAppTest` → `my-app-test`

### Secret Naming
シークレット名: `{folder}_{env}_{KEY}` (例: `gcloud-sec_dev_DATABASE_URL`)

### Scan Status
- `[OK]` - 登録済み、ローカルとリモートが一致
- `[DIFF]` - 差分あり
- `[NEW]` - 未登録

### Pre-commit Auto Sync
`gcloud-secrets pre-commit` は commit 時に .env を自動同期する:
- キャッシュ (`~/.secrets-manager-cache.json`) で .env 変更を検知
- 変更なし → 0 API コール（即座に終了）
- 変更あり → `listSecrets` のフィルタ + 並列取得で高速チェック＆自動 push
- `gcloud-secrets hook install` でグローバル git hook として設定

## Development

### Pre-push Hook
`git push` 時に自動で:
1. バージョンが npm と同じなら patch を上げる
2. npm publish
3. git tag 作成 & push

### Files
- `cli.js` - メイン CLI 実装
- `skills/secrets.md` - Claude Code スキル定義
- `.husky/pre-push` - 自動リリースフック
