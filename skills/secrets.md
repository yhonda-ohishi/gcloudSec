---
name: secrets
description: |
  Google Drive + age 暗号化で .env をバックアップ・同期する CLI `/usr/bin/gcloud-secrets` (パッケージ `@yhonda/gcloud-secrets`) の使い方ガイド。
  トリガー: 「secret」「シークレット」「.env backup」「Drive 同期」「gcloud-secrets」「backup 漏れ」「init」「reauth」「invalid_grant」「.env を Drive にあげたい」「環境変数 backup」等。
  最初に `gcloud-secrets` を引数なしで叩いて最新のコマンド一覧を取得し、user の意図に合うサブコマンドを選んで実行する。
---

# Skill: secrets (Drive + age backup)

`/usr/bin/gcloud-secrets` は **Google Drive に age 暗号化した `.env` を保管する CLI** (パッケージ `@yhonda/gcloud-secrets`、source: `~/gcloudSec`)。
GCP Secret Manager 連携の方 (`gcloud-secrets-mcp`) は廃止済 — このスキルは **Drive 版のみ** を扱う。

## 鉄則 (これだけ覚えれば事故らない)

1. **`gcloud-secrets init` を引数なしで叩かない** — Drive に新フォルダを作って `.secrets-manager.conf` を上書きする (v3.x 以降は guard 入り、それ以前は事故る)。Token を取り直したいだけなら **必ず `gcloud-secrets reauth`**。
2. **使い方を忘れたら `gcloud-secrets` (引数なし)** — 常に最新の help を出す。このスキルが古くても CLI 側が source of truth。
3. **作業 cwd = フォルダ名** — `push` / `pull` は cwd のディレクトリ名を Drive フォルダ名として扱う。明示指定したい時は `<folder>` を渡す。
4. **環境**: `--env dev / staging / prod`。省略時は `~/.secrets-manager.conf` の `DEFAULT_ENVIRONMENT`。
5. **SSH + 別マシン (Windows VSCode 等) なら Device Flow**: `reauth` は Device Flow なので URL とコードが出るだけ、別マシンのブラウザで承認して OK (port forward 不要)。

## 最初にやること (Claude が skill 起動時に必ず実行)

```bash
gcloud-secrets 2>&1 | head -40
```

→ 最新のコマンド一覧が出る。user の意図とマッチするサブコマンドを選ぶ。

## よく使う workflow と判断フロー

| user 発言 | 実行コマンド |
|---|---|
| 「全 repo の backup 漏れ確認」「scan して」 | `gcloud-secrets scan ~/ --env dev` |
| 「この .env を backup」「push したい」 | `cd <project> && gcloud-secrets push <folder> .env --env dev` |
| 「Drive から復元」「pull」 | `cd <project> && gcloud-secrets pull <folder> --env dev` |
| 「invalid_grant」「token 切れた」「7 日経った」 | `gcloud-secrets reauth` (Device Flow) |
| 「特定の値どこで使われてる？」 | `gcloud-secrets search "<value>"` |
| 「git commit 時に自動同期したい」 | `gcloud-secrets hook install` |
| 「age 秘密鍵 backup」 | `gcloud-secrets key backup` / `key restore` |

実コマンド名 / フラグは CLI の help が source of truth。記憶でなく **必ず help を見てから叩く**。

## エラー別ガイド

| 症状 | 対応 |
|---|---|
| `invalid_grant` (refresh token 失効) | `gcloud-secrets reauth` (Device Flow URL を別ブラウザで開く) |
| `エラー: 既に init 済みです (DRIVE_FOLDER_ID=...)` | 通常はそのまま使える。実は本当に再 init したい時のみ `--force` |
| `エラー: 先に init を実行してください` | conf 喪失。次節「conf 復旧」へ |
| `エラー: Device flow 用 OAuth client が未設定です` | GCP Console で "TVs and Limited Input devices" タイプの OAuth client 作成 → conf に `GOOGLE_DEVICE_CLIENT_ID` / `GOOGLE_DEVICE_CLIENT_SECRET` 追記 |

## conf 喪失時の復旧

`~/.secrets-manager.conf` が消えた場合:
1. `GOOGLE_CLIENT_ID/SECRET` は `~/gcloudSec/.env` にコピーが残っている (`set -a; source ~/gcloudSec/.env; set +a`)
2. `AGE_PUBLIC_KEY` は `age-keygen -y ~/.age/key.txt` で再導出
3. **`DRIVE_FOLDER_ID` は Drive 上で名前 "gcloud-secrets" のフォルダを検索** (複数あれば子ファイル数の多い方が本物):
   ```bash
   # Drive 上の同名フォルダ一覧 (googleapis 経由)
   node -e "
   const { google } = require('/usr/lib/node_modules/@yhonda/gcloud-secrets/node_modules/googleapis');
   const tokens = require('/home/yhonda/.secrets-manager-oauth.json');
   const ci = process.env.GOOGLE_CLIENT_ID, cs = process.env.GOOGLE_CLIENT_SECRET;
   const oauth2 = new google.auth.OAuth2(ci, cs, 'http://localhost:3456/callback');
   oauth2.setCredentials(tokens);
   google.drive({version:'v3', auth: oauth2}).files.list({
     q: \"name='gcloud-secrets' and mimeType='application/vnd.google-apps.folder' and trashed=false\",
     fields: 'files(id, name, createdTime)',
   }).then(r => console.log(JSON.stringify(r.data.files, null, 2)));
   "
   ```
4. `~/.secrets-manager-oauth.json` が失効していれば先に `mv` で退避 → `gcloud-secrets init <folder-id> --client-id "$GOOGLE_CLIENT_ID" --client-secret "$GOOGLE_CLIENT_SECRET" --env dev --age-pub "<age-pub>" --age-key ~/.age/key.txt` で復旧

## 設定ファイルの位置

- `~/.secrets-manager.conf` — Drive folder ID / OAuth client / age 鍵パス
- `~/.secrets-manager-oauth.json` — refresh token (失効したら reauth)
- `~/.secrets-manager-cache.json` — ローカル同期ハッシュ (push 高速化用)
- `~/.secrets-manager-scan-ignore.txt` — SessionStart hook 用の警告抑制リスト (1 行 1 プロジェクト名)
- `~/.age/key.txt` — age 秘密鍵 (これが消えると全 backup 復号不能 → `key backup` で Drive 退避)

## SessionStart hook (自動警告)

`~/.claude/hooks/session-start-secret-scan.sh` が毎セッション scan を実行し、未登録 / 差分あり / .gitignore 漏れがあれば session に注入する。
- benign な警告は `~/.secrets-manager-scan-ignore.txt` に 1 行追加で抑制可
- auth 失効も検知 → `reauth` を促す
