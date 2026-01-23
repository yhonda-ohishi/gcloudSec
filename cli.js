#!/usr/bin/env node

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "fs";
import { basename, join, dirname, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// SDK クライアント初期化
const client = new SecretManagerServiceClient();

// 設定読み込み
function getConfig() {
  const configFile = `${homedir()}/.secrets-manager.conf`;
  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf-8");
    const match = content.match(/SECRETS_CENTRAL_PROJECT=(.+)/);
    if (match) {
      return { centralProject: match[1].trim() };
    }
  }
  return { centralProject: process.env.SECRETS_CENTRAL_PROJECT || "" };
}

// シークレット名生成
function makeSecretName(folder, key) {
  return `${folder}_${key}`;
}

// シークレット名からキーを抽出
function getKeyFromSecret(secretName) {
  const parts = secretName.split("_");
  return parts.slice(1).join("_");
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

// CLI モード
async function runCli(args) {
  const command = args[0];
  const config = getConfig();

  if (!config.centralProject && command !== "init") {
    console.error("エラー: 先に init を実行してください");
    process.exit(1);
  }

  try {
    switch (command) {
      case "init": {
        const projectId = args[1];
        if (!projectId) {
          console.error("使い方: gcloud-secrets init <project-id>");
          process.exit(1);
        }
        const configFile = `${homedir()}/.secrets-manager.conf`;
        writeFileSync(configFile, `SECRETS_CENTRAL_PROJECT=${projectId}\n`);
        console.log(`設定完了: ${projectId}`);
        break;
      }

      case "list": {
        const folder = args[1];
        const parent = `projects/${config.centralProject}`;
        const [secrets] = await client.listSecrets({ parent });

        if (!folder) {
          const folders = new Set();
          for (const secret of secrets) {
            const [labels] = await client.getSecret({ name: secret.name });
            if (labels.labels?.folder) {
              folders.add(labels.labels.folder);
            }
          }
          console.log("フォルダ一覧:");
          for (const f of folders) {
            console.log(`  ${f}`);
          }
        } else {
          console.log(`${folder} のシークレット:`);
          for (const secret of secrets) {
            const [secretData] = await client.getSecret({ name: secret.name });
            if (secretData.labels?.folder === folder) {
              const key = getKeyFromSecret(secret.name.split("/").pop());
              console.log(`  ${key}`);
            }
          }
        }
        break;
      }

      case "pull": {
        const folder = normalizeFolder(args[1] || basename(process.cwd()));
        const parent = `projects/${config.centralProject}`;
        const [secrets] = await client.listSecrets({ parent });

        const envLines = [];
        for (const secret of secrets) {
          const [secretData] = await client.getSecret({ name: secret.name });
          if (secretData.labels?.folder === folder) {
            const key = getKeyFromSecret(secret.name.split("/").pop());
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
        console.log(envLines.join("\n"));
        break;
      }

      case "push": {
        const folder = normalizeFolder(args[1] || basename(process.cwd()));
        const envFile = args[2] || ".env";

        if (!existsSync(envFile)) {
          console.error(`ファイルが見つかりません: ${envFile}`);
          process.exit(1);
        }

        const content = readFileSync(envFile, "utf-8");
        const lines = content.split("\n");
        const parent = `projects/${config.centralProject}`;
        let count = 0;

        for (const line of lines) {
          if (!line.trim() || line.startsWith("#")) continue;
          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
          if (match) {
            const [, key, value] = match;
            const secretId = makeSecretName(folder, key);
            const secretName = `${parent}/secrets/${secretId}`;

            try {
              await client.getSecret({ name: secretName });
              await client.addSecretVersion({
                parent: secretName,
                payload: { data: Buffer.from(value) },
              });
            } catch {
              await client.createSecret({
                parent,
                secretId,
                secret: { replication: { automatic: {} }, labels: { folder } },
              });
              await client.addSecretVersion({
                parent: secretName,
                payload: { data: Buffer.from(value) },
              });
            }
            count++;
          }
        }
        console.log(`${count} 件のシークレットをアップロードしました (${folder})`);
        break;
      }

      case "scan": {
        const basePath = args[1] || homedir();
        const repos = findGitRepositories(basePath, 5);
        const parent = `projects/${config.centralProject}`;
        const [allSecrets] = await client.listSecrets({ parent });

        // フォルダごとにグループ化
        const secretsByFolder = new Map();
        for (const secret of allSecrets) {
          const [secretData] = await client.getSecret({ name: secret.name });
          const f = secretData.labels?.folder;
          if (f) {
            if (!secretsByFolder.has(f)) secretsByFolder.set(f, []);
            secretsByFolder.get(f).push(secret);
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

            const folderSecrets = secretsByFolder.get(normalizedFolder) || [];

            if (folderSecrets.length === 0) {
              results.push({ status: "NEW", repo: repoName, file: envFile.filename, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
              newCount++;
              continue;
            }

            // リモート値取得・比較
            let hasDiff = false;
            const remoteKeys = new Set();
            const remoteValues = new Map();

            for (const secret of folderSecrets) {
              const key = getKeyFromSecret(secret.name.split('/').pop());
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
              results.push({ status: "DIFF", repo: repoName, file: envFile.filename, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
              diffCount++;
            } else {
              results.push({ status: "OK", repo: repoName, file: envFile.filename, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
              syncedCount++;
            }
          }
        }

        console.log("=== Secret Manager 同期状況 ===\n");
        if (results.length === 0) {
          console.log(".env / .dev.vars ファイルが見つかりませんでした");
        } else {
          for (const r of results) {
            const label = r.status === "OK" ? "[OK]  " : r.status === "DIFF" ? "[DIFF]" : "[NEW] ";
            const suffix = r.status === "DIFF" ? " - 差分あり" : r.status === "NEW" ? " - 未登録" : "";
            const warn = !r.gitIgnored ? " ⚠" : "";
            console.log(`${label} ${r.repo}/ ${r.file} (${r.keyCount} keys)${suffix}${warn}`);
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

      default:
        console.log(`gcloud-secrets - GCP Secret Manager CLI

使い方:
  gcloud-secrets init <project-id>   中央プロジェクトを設定
  gcloud-secrets list [folder]       一覧表示
  gcloud-secrets pull [folder]       シークレットを取得
  gcloud-secrets push [folder] [file] シークレットをアップロード
  gcloud-secrets scan [basePath]     Git リポジトリの .env 同期状況をスキャン
`);
    }
  } catch (error) {
    console.error(`エラー: ${error.message}`);
    process.exit(1);
  }
}

// メイン
runCli(process.argv.slice(2));
