# Skill: secrets

GCP Secret Manager を使って .env ファイルを管理するスキル

## コマンド一覧

### 初期化
```bash
gcloud-secrets init <project-id> [--env <default>]
```
GCP プロジェクト ID を設定します。`--env` でデフォルト環境を指定できます（省略時は `dev`）。

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
Secret Manager から .env 形式でシークレットを取得します。

### シークレット登録 (push)
```bash
# .env ファイルをアップロード (dev 環境)
gcloud-secrets push --env dev

# 指定フォルダにアップロード (prod 環境)
gcloud-secrets push <folder> --env prod

# 指定ファイルをアップロード
gcloud-secrets push <folder> <file> --env staging
```

### 同期状況スキャン (scan)
```bash
# ホームディレクトリ以下をスキャン (全環境)
gcloud-secrets scan

# 特定環境のみスキャン
gcloud-secrets scan --env dev

# 指定ディレクトリ以下をスキャン
gcloud-secrets scan <path> --env prod
```
Git リポジトリ内の .env / .dev.vars ファイルと Secret Manager の同期状況を確認します。

出力例:
```
=== Secret Manager 同期状況 ===

[OK]   project-a/ .env [dev] (3 keys)
[DIFF] project-b/ .env [prod] (2 keys) - 差分あり
[NEW]  project-c/ .dev.vars [dev] (5 keys) - 未登録

---
合計: 3 ファイル
  登録済み: 1
  差分あり: 1
  未登録: 1
```

## 環境 (Environment) オプション

`--env` または `-e` で環境を指定できます:
- `dev` - 開発環境
- `staging` - ステージング環境
- `prod` - 本番環境
- その他任意の文字列

デフォルト環境は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT` で設定されます。

## 使用例

```bash
# 1. 初期化 (デフォルト環境を dev に設定)
gcloud-secrets init my-gcp-project --env dev

# 2. dev 環境に .env を登録
gcloud-secrets push --env dev

# 3. prod 環境から取得
gcloud-secrets pull --env prod > .env.prod

# 4. 全リポジトリの同期状況を確認
gcloud-secrets scan ~/

# 5. dev 環境のみスキャン
gcloud-secrets scan ~/ --env dev
```
