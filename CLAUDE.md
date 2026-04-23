# gcloudSec - シークレット管理 CLI (Google Drive + age 暗号化)

## Overview
Google Drive に age 暗号化した .env ファイルを保存・管理する CLI ツール。
フォルダ/環境ごとに暗号化ファイルを分割し、GitHub clone 風の操作で同期管理する。

## Commands
```bash
gcloud-secrets init [drive-folder-id] --client-id <id> --client-secret <secret> [--env <default>]
gcloud-secrets reauth                                # OAuth token 失効時の再認証 (config は触らない)
gcloud-secrets list [folder] [--env <env>]          # フォルダ/シークレット一覧
gcloud-secrets pull [folder] [--env <env>]          # シークレットを .env 形式で取得
gcloud-secrets push [folder] [file] [--env <env>]   # .env をアップロード
gcloud-secrets scan [basePath] [--env <env>]        # Git リポジトリの同期状況をスキャン
gcloud-secrets search <keyword> [--env <env>]       # 値から逆引き検索
gcloud-secrets pre-commit                           # .env 自動同期 (git hook 用)
gcloud-secrets hook install                         # グローバル git hook インストール
gcloud-secrets hook uninstall                       # グローバル git hook アンインストール
```

## Key Concepts

### Architecture
シークレットは Google Drive 上に age 暗号化ファイルとして保存:
```
Drive Root Folder (DRIVE_FOLDER_ID)
├── my-app/
│   ├── dev.env.age
│   └── prod.env.age
├── other-service/
│   └── dev.env.age
```

### Configuration
`~/.secrets-manager.conf`:
- `DRIVE_FOLDER_ID` - Drive ルートフォルダ ID
- `DEFAULT_ENVIRONMENT` - デフォルト環境
- `AGE_PUBLIC_KEY` - age 公開鍵 (`age1...`)
- `AGE_KEY_PATH` - age 秘密鍵パス (デフォルト: `~/.age/key.txt`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - OAuth クライアント情報

### Environment (環境)
`--env` または `-e` で環境を指定できる:
- `gcloud-secrets push --env dev` → dev 環境にアップロード
- `gcloud-secrets pull -e prod` → prod 環境から取得
- デフォルト環境は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT` で設定

### Folder Naming
フォルダ名は自動で正規化される (camelCase → kebab-case):
- `gcloudSec` → `gcloud-sec`
- `myAppTest` → `my-app-test`

### Scan Status
- `[OK]` - 登録済み、ローカルとリモートが一致
- `[DIFF]` - 差分あり
- `[NEW]` - 未登録

### Pre-commit Auto Sync
`gcloud-secrets pre-commit` は commit 時に .env を自動同期する:
- キャッシュ (`~/.secrets-manager-cache.json`) で .env 変更を検知
- 変更なし → 0 API コール（即座に終了）
- 変更あり → Drive からダウンロード＋復号で比較、差分があれば暗号化＋アップロード
- `gcloud-secrets hook install` でグローバル git hook として設定

### Prerequisites
- `age` CLI がインストール済み
- Google Cloud Console で OAuth 2.0 クライアント（デスクトップアプリ）を作成済み
- `gcloud-secrets init` で初期設定済み

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
