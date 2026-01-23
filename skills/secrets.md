# Skill: secrets

GCP Secret Manager を使って .env ファイルを管理するスキル

## コマンド一覧

### 初期化
```bash
gcloud-secrets init <project-id>
```
GCP プロジェクト ID を設定します。

### 一覧表示
```bash
# フォルダ一覧
gcloud-secrets list

# 特定フォルダのシークレット一覧
gcloud-secrets list <folder>
```

### シークレット取得 (pull)
```bash
# カレントディレクトリ名をフォルダ名として取得
gcloud-secrets pull

# 指定フォルダから取得
gcloud-secrets pull <folder>
```
Secret Manager から .env 形式でシークレットを取得します。

### シークレット登録 (push)
```bash
# .env ファイルをアップロード
gcloud-secrets push

# 指定フォルダにアップロード
gcloud-secrets push <folder>

# 指定ファイルをアップロード
gcloud-secrets push <folder> <file>
```

### 同期状況スキャン (scan)
```bash
# ホームディレクトリ以下をスキャン
gcloud-secrets scan

# 指定ディレクトリ以下をスキャン
gcloud-secrets scan <path>
```
Git リポジトリ内の .env / .dev.vars ファイルと Secret Manager の同期状況を確認します。

出力例:
```
=== Secret Manager 同期状況 ===

[OK]   project-a/ .env (3 keys)
[DIFF] project-b/ .env (2 keys) - 差分あり
[NEW]  project-c/ .dev.vars (5 keys) - 未登録

---
合計: 3 ファイル
  登録済み: 1
  差分あり: 1
  未登録: 1
```

## 使用例

```bash
# 1. 初期化
gcloud-secrets init my-gcp-project

# 2. 現在のプロジェクトの .env を登録
gcloud-secrets push

# 3. 別環境で取得
gcloud-secrets pull > .env

# 4. 全リポジトリの同期状況を確認
gcloud-secrets scan ~/
```
