# gcloudSec - GCP Secret Manager CLI

## Overview
GCP Secret Manager を GitHub clone 風に管理する CLI ツール。
`.env` ファイルと Secret Manager を同期管理する。

## Commands
```bash
gcloud-secrets init <project-id>   # 中央プロジェクトを設定
gcloud-secrets list [folder]       # フォルダ/シークレット一覧
gcloud-secrets pull [folder]       # シークレットを .env 形式で取得
gcloud-secrets push [folder] [file] # .env をアップロード
gcloud-secrets scan [basePath]     # Git リポジトリの同期状況をスキャン
```

## Key Concepts

### Folder Naming
フォルダ名は自動で正規化される (camelCase → kebab-case):
- `gcloudSec` → `gcloud-sec`
- `myAppTest` → `my-app-test`

### Secret Naming
シークレット名: `{folder}_{KEY}` (例: `gcloud-sec_DATABASE_URL`)

### Scan Status
- `[OK]` - 登録済み、ローカルとリモートが一致
- `[DIFF]` - 差分あり
- `[NEW]` - 未登録

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
