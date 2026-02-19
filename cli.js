#!/usr/bin/env node

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, mkdirSync, chmodSync, rmSync } from "fs";
import { createHash } from "crypto";
import { basename, join, dirname, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// SDK クライアント初期化
const client = new SecretManagerServiceClient();

// 引数パース (--env / -e オプション抽出)
function parseArgs(args) {
  const result = { positional: [], env: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' || args[i] === '-e') {
      result.env = args[i + 1];
      i++;
    } else if (args[i].startsWith('--env=')) {
      result.env = args[i].split('=')[1];
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}

// 設定読み込み
function getConfig() {
  const configFile = `${homedir()}/.secrets-manager.conf`;
  const config = {
    centralProject: process.env.SECRETS_CENTRAL_PROJECT || "",
    defaultEnvironment: process.env.DEFAULT_ENVIRONMENT || "dev"
  };
  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf-8");
    const projectMatch = content.match(/SECRETS_CENTRAL_PROJECT=(.+)/);
    if (projectMatch) {
      config.centralProject = projectMatch[1].trim();
    }
    const envMatch = content.match(/DEFAULT_ENVIRONMENT=(.+)/);
    if (envMatch) {
      config.defaultEnvironment = envMatch[1].trim();
    }
  }
  return config;
}

// シークレット名生成 (環境対応)
function makeSecretName(folder, key, env = null) {
  if (env) {
    return `${folder}_${env}_${key}`;
  }
  return `${folder}_${key}`;
}

// シークレット名からキーと環境を抽出
function getKeyFromSecret(secretName, folderName) {
  const prefix = folderName + "_";
  if (!secretName.startsWith(prefix)) {
    return { key: secretName, env: null };
  }
  const rest = secretName.slice(prefix.length);
  const parts = rest.split("_");
  // 2つ以上のパートがあり、最初がアルファベット小文字のみなら環境名と判断
  if (parts.length >= 2 && /^[a-z]+$/.test(parts[0])) {
    return { key: parts.slice(1).join("_"), env: parts[0] };
  }
  return { key: rest, env: null };
}

// フォルダ名を正規化 (camelCase → kebab-case)
function normalizeFolder(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')  // camelCase → kebab-case
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

// Git リポジトリを再帰的に検索
function findGitRepositories(basePath, maxDepth = 5, currentDepth = 0) {
  const repos = [];
  if (currentDepth > maxDepth) return repos;

  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = join(basePath, entry.name);
      try {
        if (lstatSync(fullPath).isSymbolicLink()) continue;
      } catch { continue; }

      if (entry.name === '.git') {
        repos.push(dirname(fullPath));
      } else {
        repos.push(...findGitRepositories(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch { }
  return repos;
}

// .env ファイルを検索
function findEnvFiles(repoPath) {
  const envFiles = [];
  for (const filename of ['.env', '.dev.vars', '.env.local', '.env.production']) {
    const filePath = join(repoPath, filename);
    if (existsSync(filePath)) {
      let gitIgnored = false;
      try {
        execSync(`git -C "${repoPath}" check-ignore -q "${filename}"`, { stdio: 'ignore' });
        gitIgnored = true;
      } catch { }
      envFiles.push({ path: filePath, filename, gitIgnored });
    }
  }
  return envFiles;
}

// .env ファイルをパース
function parseEnvFile(content) {
  const entries = [];
  const multilineRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*`([\s\S]*?)`/gm;
  let remaining = content;
  let match;
  while ((match = multilineRegex.exec(content)) !== null) {
    entries.push({ key: match[1], value: match[2] });
    remaining = remaining.replace(match[0], '');
  }
  for (const line of remaining.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const lineMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (lineMatch) {
      entries.push({ key: lineMatch[1], value: lineMatch[2].replace(/^["']|["']$/g, '') });
    }
  }
  return entries;
}

// 値の比較
function compareValues(a, b) {
  return a.trim().replace(/\r\n/g, '\n') === b.trim().replace(/\r\n/g, '\n');
}

// キャッシュ管理
function getCachePath() {
  return join(homedir(), '.secrets-manager-cache.json');
}

function readCache() {
  const cachePath = getCachePath();
  if (existsSync(cachePath)) {
    try { return JSON.parse(readFileSync(cachePath, 'utf-8')); } catch { return {}; }
  }
  return {};
}

function writeCache(cache) {
  writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
}

function hashContent(content) {
  return createHash('md5').update(content).digest('hex');
}

// CLI モード
async function runCli(args) {
  const parsed = parseArgs(args);
  const command = parsed.positional[0];
  const config = getConfig();
  const targetEnv = parsed.env || config.defaultEnvironment;

  if (!config.centralProject && command !== "init" && command !== "pre-commit" && command !== "hook") {
    console.error("エラー: 先に init を実行してください");
    process.exit(1);
  }

  try {
    switch (command) {
      case "init": {
        const projectId = parsed.positional[1];
        const defaultEnv = parsed.env || "dev";
        if (!projectId) {
          console.error("使い方: gcloud-secrets init <project-id> [--env <default-env>]");
          process.exit(1);
        }
        const configFile = `${homedir()}/.secrets-manager.conf`;
        const configContent = `SECRETS_CENTRAL_PROJECT=${projectId}\nDEFAULT_ENVIRONMENT=${defaultEnv}\n`;
        writeFileSync(configFile, configContent);
        console.log(`設定完了: ${projectId} (デフォルト環境: ${defaultEnv})`);
        break;
      }

      case "list": {
        const folder = parsed.positional[1];
        const parent = `projects/${config.centralProject}`;
        const [secrets] = await client.listSecrets({ parent });

        if (!folder) {
          // フォルダ一覧 (環境ごとにグループ化)
          const folderEnvs = new Map();
          for (const secret of secrets) {
            const [secretData] = await client.getSecret({ name: secret.name });
            if (secretData.labels?.folder) {
              const f = secretData.labels.folder;
              const e = secretData.labels?.environment || "(default)";
              if (!folderEnvs.has(f)) folderEnvs.set(f, new Set());
              folderEnvs.get(f).add(e);
            }
          }
          console.log("フォルダ一覧:");
          for (const [f, envs] of folderEnvs) {
            const envList = Array.from(envs).sort().join(', ');
            console.log(`  ${f} [${envList}]`);
          }
        } else {
          // 特定フォルダのシークレット一覧 (環境でフィルタ)
          console.log(`${folder} (${targetEnv}) のシークレット:`);
          for (const secret of secrets) {
            const [secretData] = await client.getSecret({ name: secret.name });
            const secretEnv = secretData.labels?.environment || null;
            if (secretData.labels?.folder === folder && secretEnv === targetEnv) {
              const { key } = getKeyFromSecret(secret.name.split("/").pop(), folder);
              console.log(`  ${key}`);
            }
          }
        }
        break;
      }

      case "pull": {
        const folder = normalizeFolder(parsed.positional[1] || basename(process.cwd()));
        const parent = `projects/${config.centralProject}`;
        const [secrets] = await client.listSecrets({ parent });

        const envLines = [];
        for (const secret of secrets) {
          const [secretData] = await client.getSecret({ name: secret.name });
          const secretEnv = secretData.labels?.environment || null;
          if (secretData.labels?.folder === folder && secretEnv === targetEnv) {
            const { key } = getKeyFromSecret(secret.name.split("/").pop(), folder);
            const [version] = await client.accessSecretVersion({
              name: `${secret.name}/versions/latest`,
            });
            const value = version.payload.data.toString("utf-8");
            if (value.includes("\n")) {
              envLines.push(`${key}=\`${value}\``);
            } else {
              envLines.push(`${key}=${value}`);
            }
          }
        }
        if (envLines.length === 0) {
          console.error(`警告: ${folder} (${targetEnv}) にシークレットが見つかりません`);
        } else {
          console.log(envLines.join("\n"));
        }
        break;
      }

      case "push": {
        const folder = normalizeFolder(parsed.positional[1] || basename(process.cwd()));
        const envFile = parsed.positional[2] || ".env";

        if (!existsSync(envFile)) {
          console.error(`ファイルが見つかりません: ${envFile}`);
          process.exit(1);
        }

        const content = readFileSync(envFile, "utf-8");
        const lines = content.split("\n");
        const parent = `projects/${config.centralProject}`;
        const labels = { folder, environment: targetEnv };
        let count = 0;

        for (const line of lines) {
          if (!line.trim() || line.startsWith("#")) continue;
          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
          if (match) {
            const [, key, value] = match;
            const secretId = makeSecretName(folder, key, targetEnv);
            const secretName = `${parent}/secrets/${secretId}`;

            try {
              await client.getSecret({ name: secretName });
              // 既存シークレットのラベルも更新
              await client.updateSecret({
                secret: { name: secretName, labels },
                updateMask: { paths: ['labels'] }
              });
              await client.addSecretVersion({
                parent: secretName,
                payload: { data: Buffer.from(value) },
              });
            } catch {
              await client.createSecret({
                parent,
                secretId,
                secret: { replication: { automatic: {} }, labels },
              });
              await client.addSecretVersion({
                parent: secretName,
                payload: { data: Buffer.from(value) },
              });
            }
            count++;
          }
        }
        console.log(`${count} 件のシークレットをアップロードしました (${folder}/${targetEnv})`);
        break;
      }

      case "scan": {
        const basePath = parsed.positional[1] || homedir();
        const filterEnv = parsed.env; // null の場合は全環境を表示
        const repos = findGitRepositories(basePath, 5);
        const parent = `projects/${config.centralProject}`;
        const [allSecrets] = await client.listSecrets({ parent });

        // フォルダ+環境ごとにグループ化
        const secretsByFolderEnv = new Map();
        for (const secret of allSecrets) {
          const [secretData] = await client.getSecret({ name: secret.name });
          const f = secretData.labels?.folder;
          const e = secretData.labels?.environment || null;
          if (f) {
            const key = `${f}|${e || ''}`;
            if (!secretsByFolderEnv.has(key)) secretsByFolderEnv.set(key, []);
            secretsByFolderEnv.get(key).push({ secret, env: e });
          }
        }

        const results = [];
        let syncedCount = 0, diffCount = 0, newCount = 0;

        for (const repoPath of repos) {
          const envFiles = findEnvFiles(repoPath);
          if (envFiles.length === 0) continue;

          const repoName = basename(resolve(repoPath));
          const normalizedFolder = normalizeFolder(repoName);

          for (const envFile of envFiles) {
            let content;
            try { content = readFileSync(envFile.path, 'utf-8'); } catch { continue; }
            if (!content.trim()) continue;

            const localEntries = parseEnvFile(content);
            if (localEntries.length === 0) continue;

            // 環境フィルタがある場合はその環境のみ、なければ全環境をチェック
            const envsToCheck = filterEnv ? [filterEnv] : [null, ...Array.from(new Set(
              Array.from(secretsByFolderEnv.keys())
                .filter(k => k.startsWith(normalizedFolder + '|'))
                .map(k => k.split('|')[1])
                .filter(Boolean)
            ))];

            for (const checkEnv of envsToCheck) {
              const mapKey = `${normalizedFolder}|${checkEnv || ''}`;
              const folderSecrets = secretsByFolderEnv.get(mapKey) || [];
              const envLabel = checkEnv || "(default)";

              if (folderSecrets.length === 0) {
                results.push({ status: "NEW", repo: repoName, file: envFile.filename, env: envLabel, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                newCount++;
                continue;
              }

              // リモート値取得・比較
              let hasDiff = false;
              const remoteKeys = new Set();
              const remoteValues = new Map();

              for (const { secret } of folderSecrets) {
                const { key } = getKeyFromSecret(secret.name.split('/').pop(), normalizedFolder);
                remoteKeys.add(key);
                try {
                  const [version] = await client.accessSecretVersion({ name: `${secret.name}/versions/latest` });
                  remoteValues.set(key, version.payload.data.toString('utf8'));
                } catch { }
              }

              for (const entry of localEntries) {
                if (!remoteKeys.has(entry.key) || !compareValues(entry.value, remoteValues.get(entry.key) || '')) {
                  hasDiff = true;
                  break;
                }
              }
              if (!hasDiff) {
                for (const key of remoteKeys) {
                  if (!localEntries.find(e => e.key === key)) { hasDiff = true; break; }
                }
              }

              if (hasDiff) {
                results.push({ status: "DIFF", repo: repoName, file: envFile.filename, env: envLabel, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                diffCount++;
              } else {
                results.push({ status: "OK", repo: repoName, file: envFile.filename, env: envLabel, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                syncedCount++;
              }
            }
          }
        }

        const envSuffix = filterEnv ? ` (${filterEnv})` : "";
        console.log(`=== Secret Manager 同期状況${envSuffix} ===\n`);
        if (results.length === 0) {
          console.log(".env / .dev.vars ファイルが見つかりませんでした");
        } else {
          for (const r of results) {
            const label = r.status === "OK" ? "[OK]  " : r.status === "DIFF" ? "[DIFF]" : "[NEW] ";
            const suffix = r.status === "DIFF" ? " - 差分あり" : r.status === "NEW" ? " - 未登録" : "";
            const warn = !r.gitIgnored ? " ⚠" : "";
            console.log(`${label} ${r.repo}/ ${r.file} [${r.env}] (${r.keyCount} keys)${suffix}${warn}`);
          }
          console.log(`\n---\n合計: ${results.length} ファイル`);
          console.log(`  登録済み: ${syncedCount}`);
          console.log(`  差分あり: ${diffCount}`);
          console.log(`  未登録: ${newCount}`);
          const notIgnored = results.filter(r => !r.gitIgnored);
          if (notIgnored.length > 0) console.log(`\n⚠ .gitignore に含まれていないファイルがあります (${notIgnored.length}件)`);
        }
        break;
      }

      case "pre-commit": {
        // config なし → サイレント exit
        if (!config.centralProject) process.exit(0);

        const cwd = process.cwd();
        const folder = normalizeFolder(basename(resolve(cwd)));
        const envFiles = findEnvFiles(cwd);
        if (envFiles.length === 0) process.exit(0);

        const cache = readCache();
        const parent = `projects/${config.centralProject}`;
        let totalPushed = 0;

        for (const envFile of envFiles) {
          let content;
          try { content = readFileSync(envFile.path, 'utf-8'); } catch { continue; }
          if (!content.trim()) continue;

          const currentHash = hashContent(content);
          const cacheKey = envFile.path;

          // キャッシュヒット → スキップ (0 API コール)
          if (cache[cacheKey] && cache[cacheKey].hash === currentHash) {
            console.log(`✓ ${envFile.filename} synced`);
            continue;
          }

          const localEntries = parseEnvFile(content);
          if (localEntries.length === 0) continue;

          const labels = { folder, environment: targetEnv };

          try {
            // フィルタ付き listSecrets (1 API コール、ラベル込み)
            const filter = `labels.folder=${folder} AND labels.environment=${targetEnv}`;
            const [remoteSecrets] = await client.listSecrets({ parent, filter });

            // リモートキー → シークレット名マップ
            const remoteMap = new Map();
            for (const secret of remoteSecrets) {
              const { key } = getKeyFromSecret(secret.name.split('/').pop(), folder);
              remoteMap.set(key, secret.name);
            }

            // リモート値を並列取得
            const remoteValues = new Map();
            const keysToCompare = localEntries.filter(e => remoteMap.has(e.key));
            if (keysToCompare.length > 0) {
              const results = await Promise.all(
                keysToCompare.map(async (entry) => {
                  try {
                    const [version] = await client.accessSecretVersion({
                      name: `${remoteMap.get(entry.key)}/versions/latest`,
                    });
                    return { key: entry.key, value: version.payload.data.toString('utf-8') };
                  } catch { return { key: entry.key, value: null }; }
                })
              );
              for (const r of results) {
                if (r.value !== null) remoteValues.set(r.key, r.value);
              }
            }

            // 新規/変更キーを特定
            const toPush = [];
            for (const entry of localEntries) {
              if (!remoteMap.has(entry.key)) {
                toPush.push(entry);
              } else if (!remoteValues.has(entry.key) || !compareValues(entry.value, remoteValues.get(entry.key))) {
                toPush.push(entry);
              }
            }

            // push
            if (toPush.length > 0) {
              for (const entry of toPush) {
                const secretId = makeSecretName(folder, entry.key, targetEnv);
                const secretName = `${parent}/secrets/${secretId}`;
                try {
                  await client.getSecret({ name: secretName });
                  await client.updateSecret({
                    secret: { name: secretName, labels },
                    updateMask: { paths: ['labels'] }
                  });
                  await client.addSecretVersion({
                    parent: secretName,
                    payload: { data: Buffer.from(entry.value) },
                  });
                } catch {
                  await client.createSecret({
                    parent,
                    secretId,
                    secret: { replication: { automatic: {} }, labels },
                  });
                  await client.addSecretVersion({
                    parent: secretName,
                    payload: { data: Buffer.from(entry.value) },
                  });
                }
              }
              console.log(`↑ ${envFile.filename}: ${toPush.length} secrets pushed (${folder}/${targetEnv})`);
              totalPushed += toPush.length;
            } else {
              console.log(`✓ ${envFile.filename} synced`);
            }

            // キャッシュ更新
            cache[cacheKey] = {
              hash: currentHash,
              folder,
              env: targetEnv,
              syncedAt: new Date().toISOString()
            };
          } catch (error) {
            console.log(`⚠ ${envFile.filename}: sync skipped (${error.message})`);
          }
        }

        try { writeCache(cache); } catch { }
        process.exit(0);
      }

      case "search": {
        const keyword = parsed.positional[1];
        if (!keyword) {
          console.log("使い方: gcloud-secrets search <keyword> [--env <env>]");
          process.exit(1);
        }

        const filterEnv = parsed.env;
        const parent = `projects/${config.centralProject}`;
        const [secrets] = await client.listSecrets({ parent });

        console.log(`Searching for: "${keyword}"`);
        if (filterEnv) console.log(`  環境: ${filterEnv}`);
        console.log(`\nScanning ${secrets.length} secrets...\n`);

        const results = await Promise.all(
          secrets.map(async (secret) => {
            try {
              const [secretData] = await client.getSecret({ name: secret.name });
              const folder = secretData.labels?.folder;
              const env = secretData.labels?.environment || "(default)";

              // 環境フィルタ
              if (filterEnv && secretData.labels?.environment !== filterEnv) return null;

              // 値を取得してキーワード検索
              const [version] = await client.accessSecretVersion({
                name: `${secret.name}/versions/latest`,
              });
              const value = version.payload.data.toString("utf-8");
              if (value.includes(keyword)) {
                const { key } = getKeyFromSecret(secret.name.split("/").pop(), folder);
                return { folder, env, key };
              }
            } catch {
              // バージョンがない場合はスキップ
            }
            return null;
          })
        );

        const matches = results.filter((r) => r !== null);
        const folders = new Set(matches.map((m) => m.folder));

        if (matches.length === 0) {
          console.log("No matches found");
        } else {
          for (const m of matches) {
            console.log(`[FOUND] ${m.folder} / ${m.env} - ${m.key}`);
          }
          console.log(`\nFound ${matches.length} matches in ${folders.size} folders`);
        }
        break;
      }

      case "hook": {
        const subcommand = parsed.positional[1];

        if (subcommand === "install") {
          const hooksDir = join(homedir(), '.git-hooks');
          if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

          const hookTypes = [
            'applypatch-msg', 'pre-applypatch', 'post-applypatch',
            'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
            'pre-rebase', 'post-checkout', 'post-merge',
            'pre-push', 'pre-auto-gc', 'post-rewrite'
          ];

          for (const hookType of hookTypes) {
            const hookPath = join(hooksDir, hookType);
            let extraLogic = '';

            if (hookType === 'pre-commit') {
              extraLogic = `
# gcloud-secrets: auto-sync .env to Secret Manager
if command -v gcloud-secrets >/dev/null 2>&1; then
  gcloud-secrets pre-commit
fi
`;
            }

            const hookScript = `#!/bin/sh
# Global git hook: ${hookType}
# Installed by gcloud-secrets
${extraLogic}
# Forward to .husky/${hookType} if it exists
if [ -f "$(pwd)/.husky/${hookType}" ]; then
  "$(pwd)/.husky/${hookType}" "$@"
  exit_code=$?
  if [ $exit_code -ne 0 ]; then
    exit $exit_code
  fi
fi

# Forward to .git/hooks/${hookType} if it exists
GIT_DIR_HOOKS="$(git rev-parse --git-dir 2>/dev/null)/hooks/${hookType}"
if [ -f "$GIT_DIR_HOOKS" ] && [ -x "$GIT_DIR_HOOKS" ]; then
  "$GIT_DIR_HOOKS" "$@"
  exit $?
fi

exit 0
`;
            writeFileSync(hookPath, hookScript);
            chmodSync(hookPath, '755');
          }

          execSync('git config --global core.hooksPath ~/.git-hooks');
          console.log(`グローバル git hooks をインストールしました:
  フックディレクトリ: ${hooksDir}
  対象: pre-commit (gcloud-secrets auto-sync)
  互換性: .husky/ と .git/hooks/ にフォワード

全リポジトリの git commit で .env が自動同期されます。`);

        } else if (subcommand === "uninstall") {
          try { execSync('git config --global --unset core.hooksPath', { stdio: 'ignore' }); } catch { }
          const hooksDir = join(homedir(), '.git-hooks');
          if (existsSync(hooksDir)) {
            try {
              rmSync(hooksDir, { recursive: true, force: true });
            } catch (error) {
              console.log(`⚠ ${hooksDir} の削除に失敗: ${error.message}`);
              console.log(`手動で削除してください: rm -rf ${hooksDir}`);
            }
          }
          console.log(`グローバル git hooks をアンインストールしました。`);

        } else {
          console.log(`使い方:
  gcloud-secrets hook install      グローバル pre-commit hook をインストール
  gcloud-secrets hook uninstall    グローバル pre-commit hook をアンインストール`);
        }
        break;
      }

      default:
        console.log(`gcloud-secrets - GCP Secret Manager CLI

使い方:
  gcloud-secrets init <project-id> [--env <default>]  中央プロジェクトを設定
  gcloud-secrets list [folder] [--env <env>]          一覧表示
  gcloud-secrets pull [folder] [--env <env>]          シークレットを取得
  gcloud-secrets push [folder] [file] [--env <env>]   シークレットをアップロード
  gcloud-secrets scan [basePath] [--env <env>]        Git リポジトリの .env 同期状況をスキャン
  gcloud-secrets search <keyword> [--env <env>]       値から逆引き検索
  gcloud-secrets pre-commit                           .env 自動同期 (git hook 用)
  gcloud-secrets hook install                         グローバル git hook インストール
  gcloud-secrets hook uninstall                       グローバル git hook アンインストール

オプション:
  --env, -e <env>  環境を指定 (dev, staging, prod など)
                   省略時は設定ファイルの DEFAULT_ENVIRONMENT を使用
`);
    }
  } catch (error) {
    console.error(`エラー: ${error.message}`);
    process.exit(1);
  }
}

// メイン
runCli(process.argv.slice(2));
