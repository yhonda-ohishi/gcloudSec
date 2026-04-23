#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, mkdirSync, chmodSync, rmSync } from "fs";
import { createHash } from "crypto";
import { basename, join, dirname, resolve } from "path";
import { homedir } from "os";
import { execSync, execFileSync } from "child_process";
import { createServer } from "http";
import { google } from "googleapis";
import { Readable } from "stream";

// ============================================================
// 引数パース
// ============================================================
function parseArgs(args) {
  const result = { positional: [], env: null, ageKey: null, agePub: null, clientId: null, clientSecret: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' || args[i] === '-e') {
      result.env = args[i + 1]; i++;
    } else if (args[i].startsWith('--env=')) {
      result.env = args[i].split('=')[1];
    } else if (args[i] === '--age-key') {
      result.ageKey = args[i + 1]; i++;
    } else if (args[i] === '--age-pub') {
      result.agePub = args[i + 1]; i++;
    } else if (args[i] === '--client-id') {
      result.clientId = args[i + 1]; i++;
    } else if (args[i] === '--client-secret') {
      result.clientSecret = args[i + 1]; i++;
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}

// ============================================================
// 設定
// ============================================================
function getConfig() {
  const configFile = `${homedir()}/.secrets-manager.conf`;
  const config = {
    driveFolderId: process.env.DRIVE_FOLDER_ID || "",
    defaultEnvironment: process.env.DEFAULT_ENVIRONMENT || "dev",
    agePublicKey: process.env.AGE_PUBLIC_KEY || "",
    ageKeyPath: process.env.AGE_KEY_PATH || join(homedir(), ".age", "key.txt"),
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  };
  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf-8");
    for (const [envKey, configKey] of [
      ['DRIVE_FOLDER_ID', 'driveFolderId'],
      ['DEFAULT_ENVIRONMENT', 'defaultEnvironment'],
      ['AGE_PUBLIC_KEY', 'agePublicKey'],
      ['AGE_KEY_PATH', 'ageKeyPath'],
      ['GOOGLE_CLIENT_ID', 'googleClientId'],
      ['GOOGLE_CLIENT_SECRET', 'googleClientSecret'],
    ]) {
      const match = content.match(new RegExp(`^${envKey}=(.+)$`, 'm'));
      if (match) config[configKey] = match[1].trim();
    }
  }
  return config;
}

function writeConfig(values) {
  const configFile = `${homedir()}/.secrets-manager.conf`;
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (value) lines.push(`${key}=${value}`);
  }
  writeFileSync(configFile, lines.join('\n') + '\n');
}

// ============================================================
// age ヘルパー
// ============================================================
function checkAgeInstalled() {
  try {
    execFileSync('age', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('エラー: age がインストールされていません');
    console.error('インストール: sudo apt install age (Linux) / brew install age (macOS)');
    process.exit(1);
  }
}

function ageEncrypt(plaintext, publicKey) {
  return execFileSync('age', ['-r', publicKey], { input: Buffer.from(plaintext) });
}

function ageDecrypt(ciphertext, keyPath) {
  return execFileSync('age', ['-d', '-i', keyPath], { input: ciphertext, encoding: 'utf-8' });
}

function getAgePublicKeyFromFile(keyPath) {
  const content = readFileSync(keyPath, 'utf-8');
  const match = content.match(/# public key: (age1[a-z0-9]+)/);
  if (match) return match[1];
  throw new Error('age 公開鍵が見つかりません: ' + keyPath);
}

// ============================================================
// OAuth2 認証
// ============================================================
const OAUTH_REDIRECT_PORT = 3456;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/callback`;
const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive'];

function getTokenPath() {
  return join(homedir(), '.secrets-manager-oauth.json');
}

function isInvalidGrantError(err) {
  const msg = String(err?.message || '');
  const data = err?.response?.data || {};
  return msg.includes('invalid_grant') || data.error === 'invalid_grant';
}

async function performOAuthFlow(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    prompt: 'consent',
  });

  console.log('ブラウザで認証を行います...');
  let browserOpened = false;
  try {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execSync(`${openCmd} "${authUrl}"`, { stdio: 'ignore' });
    browserOpened = true;
  } catch { }
  if (!browserOpened) {
    console.log(`ブラウザが開けませんでした。以下のURLを手動で開いてください:\n${authUrl}`);
  } else {
    // リモートセッションなど stdio 共有環境用に URL も常時表示
    console.log(`(ブラウザが開かない場合は以下を開いてください)\n${authUrl}`);
  }

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${OAUTH_REDIRECT_PORT}`);
      const authCode = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.end('認証がキャンセルされました。');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (authCode) {
        res.end('認証完了！このタブを閉じてください。');
        server.close();
        resolve(authCode);
      }
    });
    server.listen(OAUTH_REDIRECT_PORT, () => {
      console.log(`認証待機中... (localhost:${OAUTH_REDIRECT_PORT})`);
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  const tokenPath = getTokenPath();
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log('認証完了');

  oauth2Client.on('tokens', (newTokens) => {
    try {
      const saved = JSON.parse(readFileSync(tokenPath, 'utf-8'));
      writeFileSync(tokenPath, JSON.stringify({ ...saved, ...newTokens }, null, 2));
    } catch { }
  });

  return oauth2Client;
}

async function getAuthClient(config) {
  if (!config.googleClientId || !config.googleClientSecret) {
    console.error('エラー: Google OAuth クライアント ID/Secret が設定されていません');
    console.error('init コマンドで --client-id と --client-secret を指定してください');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    OAUTH_REDIRECT_URI
  );

  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    oauth2Client.setCredentials(tokens);
    oauth2Client.on('tokens', (newTokens) => {
      try {
        const saved = JSON.parse(readFileSync(tokenPath, 'utf-8'));
        writeFileSync(tokenPath, JSON.stringify({ ...saved, ...newTokens }, null, 2));
      } catch { }
    });
    return oauth2Client;
  }

  return performOAuthFlow(oauth2Client);
}

async function getDriveClient(config) {
  const auth = await getAuthClient(config);
  return google.drive({ version: 'v3', auth });
}

// ============================================================
// Drive ヘルパー
// ============================================================
function escapeQuery(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function listDriveFolders(drive, rootFolderId) {
  const res = await drive.files.list({
    q: `'${escapeQuery(rootFolderId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

async function findFolder(drive, parentId, folderName) {
  const res = await drive.files.list({
    q: `'${escapeQuery(parentId)}' in parents and name = '${escapeQuery(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  return (res.data.files || [])[0] || null;
}

async function getOrCreateFolder(drive, parentId, folderName) {
  const existing = await findFolder(drive, parentId, folderName);
  if (existing) return existing;

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, name',
  });
  return res.data;
}

async function findEnvAgeFile(drive, parentFolderId, env) {
  const fileName = `${env}.env.age`;
  const res = await drive.files.list({
    q: `'${escapeQuery(parentFolderId)}' in parents and name = '${escapeQuery(fileName)}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  return (res.data.files || [])[0] || null;
}

async function listEnvAgeFiles(drive, parentFolderId) {
  const res = await drive.files.list({
    q: `'${escapeQuery(parentFolderId)}' in parents and name contains '.env.age' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

async function downloadFile(drive, fileId) {
  const res = await drive.files.get({
    fileId,
    alt: 'media',
  }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function uploadFile(drive, parentFolderId, fileName, content) {
  const res = await drive.files.list({
    q: `'${escapeQuery(parentFolderId)}' in parents and name = '${escapeQuery(fileName)}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });

  const existing = (res.data.files || [])[0];

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      media: {
        mimeType: 'application/octet-stream',
        body: Readable.from(content),
      },
    });
    return existing.id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media: {
        mimeType: 'application/octet-stream',
        body: Readable.from(content),
      },
      fields: 'id',
    });
    return created.data.id;
  }
}

async function listAllEnvFiles(drive, rootFolderId) {
  const folders = await listDriveFolders(drive, rootFolderId);
  const result = [];

  await Promise.all(folders.map(async (folder) => {
    const files = await listEnvAgeFiles(drive, folder.id);
    for (const file of files) {
      const envMatch = file.name.match(/^(.+)\.env\.age$/);
      if (envMatch) {
        result.push({
          fileId: file.id,
          fileName: file.name,
          folder: folder.name,
          folderId: folder.id,
          env: envMatch[1],
        });
      }
    }
  }));

  return result;
}

// ============================================================
// ユーティリティ (変更なし)
// ============================================================
function normalizeFolder(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

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
      try { if (lstatSync(fullPath).isSymbolicLink()) continue; } catch { continue; }
      if (entry.name === '.git') {
        repos.push(dirname(fullPath));
      } else {
        repos.push(...findGitRepositories(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch { }
  return repos;
}

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

// ============================================================
// CLI メイン
// ============================================================
async function runCli(args) {
  const parsed = parseArgs(args);
  const command = parsed.positional[0];
  const config = getConfig();
  const targetEnv = parsed.env || config.defaultEnvironment;

  if (!config.driveFolderId && command && command !== "init" && command !== "pre-commit" && command !== "hook") {
    console.error("エラー: 先に init を実行してください");
    process.exit(1);
  }

  try {
    switch (command) {
      case "init": {
        const driveFolderId = parsed.positional[1];
        const defaultEnv = parsed.env || "dev";
        const clientId = parsed.clientId || config.googleClientId;
        const clientSecret = parsed.clientSecret || config.googleClientSecret;

        if (!clientId || !clientSecret) {
          console.error("使い方: gcloud-secrets init [drive-folder-id] --client-id <id> --client-secret <secret> [--env <default>] [--age-pub <key>] [--age-key <path>]");
          process.exit(1);
        }

        // age チェック
        checkAgeInstalled();

        // age 鍵の設定
        let ageKeyPath = parsed.ageKey || config.ageKeyPath;
        let agePublicKey = parsed.agePub || config.agePublicKey;

        if (!existsSync(ageKeyPath)) {
          const ageDir = dirname(ageKeyPath);
          if (!existsSync(ageDir)) mkdirSync(ageDir, { recursive: true });
          console.log(`age 鍵を生成中: ${ageKeyPath}`);
          execFileSync('age-keygen', ['-o', ageKeyPath]);
        }

        if (!agePublicKey) {
          agePublicKey = getAgePublicKeyFromFile(ageKeyPath);
        }

        // OAuth 認証テスト
        const tempConfig = { ...config, googleClientId: clientId, googleClientSecret: clientSecret };
        const drive = await getDriveClient(tempConfig);

        let folderId = driveFolderId;
        if (!folderId) {
          // ルートフォルダ作成
          console.log('Drive にルートフォルダ "gcloud-secrets" を作成中...');
          const res = await drive.files.create({
            requestBody: {
              name: 'gcloud-secrets',
              mimeType: 'application/vnd.google-apps.folder',
            },
            fields: 'id, name',
          });
          folderId = res.data.id;
          console.log(`フォルダ作成完了: ${res.data.name} (${folderId})`);
        } else {
          // 既存フォルダの検証
          try {
            const res = await drive.files.get({ fileId: folderId, fields: 'id, name' });
            console.log(`Drive フォルダ確認: ${res.data.name} (${folderId})`);
          } catch {
            console.error(`エラー: Drive フォルダ ID "${folderId}" にアクセスできません`);
            process.exit(1);
          }
        }

        // 設定保存
        writeConfig({
          DRIVE_FOLDER_ID: folderId,
          DEFAULT_ENVIRONMENT: defaultEnv,
          AGE_PUBLIC_KEY: agePublicKey,
          AGE_KEY_PATH: ageKeyPath,
          GOOGLE_CLIENT_ID: clientId,
          GOOGLE_CLIENT_SECRET: clientSecret,
        });

        console.log(`設定完了:
  Drive フォルダ: ${folderId}
  デフォルト環境: ${defaultEnv}
  age 公開鍵: ${agePublicKey}
  age 秘密鍵: ${ageKeyPath}`);
        break;
      }

      case "reauth": {
        // 既存設定が揃っていること (init 済み) が前提
        if (!config.googleClientId || !config.googleClientSecret) {
          console.error('エラー: OAuth クライアント情報が未設定です');
          console.error('先に init を実行してください');
          process.exit(1);
        }
        if (!config.driveFolderId) {
          console.error('エラー: DRIVE_FOLDER_ID が未設定です');
          console.error('先に init を実行してください');
          process.exit(1);
        }

        // 失効 token を退避 (新トークン取得前に削除、既存値が残ると古い refresh_token が使われる)
        const tokenPath = getTokenPath();
        if (existsSync(tokenPath)) {
          const backupPath = `${tokenPath}.stale-${Date.now()}`;
          try {
            writeFileSync(backupPath, readFileSync(tokenPath));
            rmSync(tokenPath);
            console.log(`旧 token を退避: ${backupPath}`);
          } catch (e) {
            console.error(`警告: 旧 token の退避に失敗: ${e.message}`);
          }
        }

        // OAuth フローのみ実行
        const oauth2Client = new google.auth.OAuth2(
          config.googleClientId,
          config.googleClientSecret,
          OAUTH_REDIRECT_URI
        );
        await performOAuthFlow(oauth2Client);

        // Drive 疎通確認 (既存フォルダへの read アクセスのみ、書き込みは一切しない)
        const drive = google.drive({ version: 'v3', auth: oauth2Client });
        try {
          const res = await drive.files.get({ fileId: config.driveFolderId, fields: 'id, name' });
          console.log(`Drive フォルダ確認: ${res.data.name} (${config.driveFolderId})`);
        } catch (e) {
          console.error(`警告: Drive フォルダ検証失敗 (${e.message})`);
          console.error('token は更新済み。フォルダ ID / 権限を確認してください');
          process.exit(1);
        }
        console.log('再認証完了');
        break;
      }

      case "list": {
        const folder = parsed.positional[1];
        const drive = await getDriveClient(config);

        if (!folder) {
          // フォルダ一覧
          const folders = await listDriveFolders(drive, config.driveFolderId);
          if (folders.length === 0) {
            console.log("シークレットが登録されていません");
            break;
          }

          console.log("フォルダ一覧:");
          for (const f of folders) {
            const files = await listEnvAgeFiles(drive, f.id);
            const envs = files
              .map(file => file.name.match(/^(.+)\.env\.age$/))
              .filter(Boolean)
              .map(m => m[1])
              .sort();
            console.log(`  ${f.name} [${envs.join(', ')}]`);
          }
        } else {
          // 特定フォルダのキー一覧
          checkAgeInstalled();
          const normalizedFolder = normalizeFolder(folder);
          const folderObj = await findFolder(drive, config.driveFolderId, normalizedFolder);
          if (!folderObj) {
            console.error(`フォルダが見つかりません: ${normalizedFolder}`);
            process.exit(1);
          }

          const file = await findEnvAgeFile(drive, folderObj.id, targetEnv);
          if (!file) {
            console.error(`${normalizedFolder} (${targetEnv}) にシークレットが見つかりません`);
            break;
          }

          const encrypted = await downloadFile(drive, file.id);
          const decrypted = ageDecrypt(encrypted, config.ageKeyPath);
          const entries = parseEnvFile(decrypted);

          console.log(`${normalizedFolder} (${targetEnv}) のシークレット:`);
          for (const entry of entries) {
            console.log(`  ${entry.key}`);
          }
        }
        break;
      }

      case "pull": {
        checkAgeInstalled();
        const folder = normalizeFolder(parsed.positional[1] || basename(process.cwd()));
        const drive = await getDriveClient(config);

        const folderObj = await findFolder(drive, config.driveFolderId, folder);
        if (!folderObj) {
          console.error(`警告: ${folder} (${targetEnv}) にシークレットが見つかりません`);
          break;
        }

        const file = await findEnvAgeFile(drive, folderObj.id, targetEnv);
        if (!file) {
          console.error(`警告: ${folder} (${targetEnv}) にシークレットが見つかりません`);
          break;
        }

        const encrypted = await downloadFile(drive, file.id);
        const decrypted = ageDecrypt(encrypted, config.ageKeyPath);
        console.log(decrypted.trimEnd());
        break;
      }

      case "push": {
        checkAgeInstalled();
        const folder = normalizeFolder(parsed.positional[1] || basename(process.cwd()));
        const envFile = parsed.positional[2] || ".env";

        if (!existsSync(envFile)) {
          console.error(`ファイルが見つかりません: ${envFile}`);
          process.exit(1);
        }

        const content = readFileSync(envFile, "utf-8");
        const entries = parseEnvFile(content);
        if (entries.length === 0) {
          console.error("有効なシークレットが見つかりません");
          process.exit(1);
        }

        const drive = await getDriveClient(config);
        const folderObj = await getOrCreateFolder(drive, config.driveFolderId, folder);

        const encrypted = ageEncrypt(content, config.agePublicKey);
        const fileName = `${targetEnv}.env.age`;
        await uploadFile(drive, folderObj.id, fileName, encrypted);

        console.log(`${entries.length} 件のシークレットをアップロードしました (${folder}/${targetEnv})`);
        break;
      }

      case "scan": {
        checkAgeInstalled();
        const basePath = parsed.positional[1] || homedir();
        const filterEnv = parsed.env;
        const repos = findGitRepositories(basePath, 5);
        const drive = await getDriveClient(config);

        // リモートの全ファイルを取得
        const remoteFiles = await listAllEnvFiles(drive, config.driveFolderId);

        // リモートデータをダウンロード・復号（並列）
        const remoteData = new Map(); // key: "folder|env" -> parsed entries
        await Promise.all(remoteFiles.map(async (rf) => {
          try {
            const encrypted = await downloadFile(drive, rf.fileId);
            const decrypted = ageDecrypt(encrypted, config.ageKeyPath);
            const entries = parseEnvFile(decrypted);
            remoteData.set(`${rf.folder}|${rf.env}`, entries);
          } catch { }
        }));

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

            // チェック対象の環境を決定
            const envsToCheck = filterEnv
              ? [filterEnv]
              : [...new Set(
                  Array.from(remoteData.keys())
                    .filter(k => k.startsWith(normalizedFolder + '|'))
                    .map(k => k.split('|')[1])
                )];

            if (envsToCheck.length === 0) {
              results.push({ status: "NEW", repo: repoName, file: envFile.filename, env: filterEnv || "(default)", keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
              newCount++;
              continue;
            }

            for (const checkEnv of envsToCheck) {
              const mapKey = `${normalizedFolder}|${checkEnv}`;
              const remoteEntries = remoteData.get(mapKey);

              if (!remoteEntries) {
                results.push({ status: "NEW", repo: repoName, file: envFile.filename, env: checkEnv, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                newCount++;
                continue;
              }

              // 比較
              const remoteMap = new Map(remoteEntries.map(e => [e.key, e.value]));
              let hasDiff = false;

              for (const entry of localEntries) {
                if (!remoteMap.has(entry.key) || !compareValues(entry.value, remoteMap.get(entry.key))) {
                  hasDiff = true;
                  break;
                }
              }
              if (!hasDiff) {
                for (const re of remoteEntries) {
                  if (!localEntries.find(e => e.key === re.key)) { hasDiff = true; break; }
                }
              }

              if (hasDiff) {
                results.push({ status: "DIFF", repo: repoName, file: envFile.filename, env: checkEnv, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                diffCount++;
              } else {
                results.push({ status: "OK", repo: repoName, file: envFile.filename, env: checkEnv, keyCount: localEntries.length, gitIgnored: envFile.gitIgnored });
                syncedCount++;
              }
            }
          }
        }

        const envSuffix = filterEnv ? ` (${filterEnv})` : "";
        console.log(`=== シークレット同期状況${envSuffix} ===\n`);
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
        if (!config.driveFolderId || !config.googleClientId) process.exit(0);
        // OAuth トークンなし → サイレント exit (対話的認証を避ける)
        if (!existsSync(getTokenPath())) process.exit(0);
        // age なし → サイレント exit
        try { execFileSync('age', ['--version'], { stdio: 'ignore' }); } catch { process.exit(0); }

        const cwd = process.cwd();
        const folder = normalizeFolder(basename(resolve(cwd)));
        const envFiles = findEnvFiles(cwd);
        if (envFiles.length === 0) process.exit(0);

        const cache = readCache();
        let totalPushed = 0;

        let drive;
        try { drive = await getDriveClient(config); } catch { process.exit(0); }

        let reauthWarned = false;
        const warnReauth = () => {
          if (reauthWarned) return;
          reauthWarned = true;
          console.error('⚠ OAuth expired. Run `gcloud-secrets reauth` to re-authenticate.');
        };

        for (const envFile of envFiles) {
          if (reauthWarned) break;
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

          try {
            // リモートファイルを取得して比較
            const folderObj = await findFolder(drive, config.driveFolderId, folder);
            let needsPush = true;

            if (folderObj) {
              const remoteFile = await findEnvAgeFile(drive, folderObj.id, targetEnv);
              if (remoteFile) {
                const encrypted = await downloadFile(drive, remoteFile.id);
                const decrypted = ageDecrypt(encrypted, config.ageKeyPath);
                const remoteEntries = parseEnvFile(decrypted);
                const remoteMap = new Map(remoteEntries.map(e => [e.key, e.value]));

                // 差分チェック
                needsPush = false;
                for (const entry of localEntries) {
                  if (!remoteMap.has(entry.key) || !compareValues(entry.value, remoteMap.get(entry.key))) {
                    needsPush = true;
                    break;
                  }
                }
                if (!needsPush) {
                  for (const re of remoteEntries) {
                    if (!localEntries.find(e => e.key === re.key)) { needsPush = true; break; }
                  }
                }
              }
            }

            if (needsPush) {
              const targetFolder = await getOrCreateFolder(drive, config.driveFolderId, folder);
              const encryptedContent = ageEncrypt(content, config.agePublicKey);
              await uploadFile(drive, targetFolder.id, `${targetEnv}.env.age`, encryptedContent);
              console.log(`↑ ${envFile.filename}: pushed (${folder}/${targetEnv})`);
              totalPushed++;
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
            if (isInvalidGrantError(error)) {
              warnReauth();
              break;
            }
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

        checkAgeInstalled();
        const filterEnv = parsed.env;
        const drive = await getDriveClient(config);
        const allFiles = await listAllEnvFiles(drive, config.driveFolderId);

        // 環境フィルタ
        const targetFiles = filterEnv ? allFiles.filter(f => f.env === filterEnv) : allFiles;

        console.log(`Searching for: "${keyword}"`);
        if (filterEnv) console.log(`  環境: ${filterEnv}`);
        console.log(`\nScanning ${targetFiles.length} files...\n`);

        const results = await Promise.all(
          targetFiles.map(async (rf) => {
            try {
              const encrypted = await downloadFile(drive, rf.fileId);
              const decrypted = ageDecrypt(encrypted, config.ageKeyPath);
              const entries = parseEnvFile(decrypted);
              return entries
                .filter(e => e.value.includes(keyword))
                .map(e => ({ folder: rf.folder, env: rf.env, key: e.key }));
            } catch {
              return [];
            }
          })
        );

        const matches = results.flat();
        const folders = new Set(matches.map(m => m.folder));

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

      case "key": {
        const subcommand = parsed.positional[1];

        if (subcommand === "backup") {
          checkAgeInstalled();
          if (!existsSync(config.ageKeyPath)) {
            console.error(`エラー: age 秘密鍵が見つかりません: ${config.ageKeyPath}`);
            process.exit(1);
          }

          // gpg で暗号化
          try { execFileSync('gpg', ['--version'], { stdio: 'ignore' }); } catch {
            console.error('エラー: gpg がインストールされていません');
            process.exit(1);
          }

          const tmpGpg = join(homedir(), '.age', 'age-key.gpg');
          console.log('gpg パスワードを入力してください（復元時に必要）...');
          execSync(`gpg --symmetric --cipher-algo AES256 -o "${tmpGpg}" "${config.ageKeyPath}"`, { stdio: 'inherit' });

          // Drive にアップロード
          const drive = await getDriveClient(config);
          const gpgContent = readFileSync(tmpGpg);
          await uploadFile(drive, config.driveFolderId, 'age-key.gpg', gpgContent);
          rmSync(tmpGpg);

          console.log('age 秘密鍵を暗号化して Drive にバックアップしました (age-key.gpg)');

        } else if (subcommand === "restore") {
          // Drive からダウンロード
          const drive = await getDriveClient(config);
          const res = await drive.files.list({
            q: `'${escapeQuery(config.driveFolderId)}' in parents and name = 'age-key.gpg' and trashed = false`,
            fields: 'files(id)',
            pageSize: 1,
          });
          const file = (res.data.files || [])[0];
          if (!file) {
            console.error('エラー: Drive に age-key.gpg が見つかりません');
            process.exit(1);
          }

          const gpgData = await downloadFile(drive, file.id);
          const tmpGpg = join(homedir(), '.age', 'age-key.gpg');
          const ageDir = dirname(config.ageKeyPath);
          if (!existsSync(ageDir)) mkdirSync(ageDir, { recursive: true });

          writeFileSync(tmpGpg, gpgData);
          console.log('gpg パスワードを入力してください...');
          execSync(`gpg --decrypt -o "${config.ageKeyPath}" "${tmpGpg}"`, { stdio: 'inherit' });
          rmSync(tmpGpg);

          // 公開鍵も表示
          const pubKey = getAgePublicKeyFromFile(config.ageKeyPath);
          console.log(`age 秘密鍵を復元しました: ${config.ageKeyPath}`);
          console.log(`公開鍵: ${pubKey}`);

        } else {
          console.log(`使い方:
  gcloud-secrets key backup     age 秘密鍵を gpg 暗号化して Drive にバックアップ
  gcloud-secrets key restore    Drive から age 秘密鍵を復元`);
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
# gcloud-secrets: auto-sync .env to Drive
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
        console.log(`gcloud-secrets - シークレット管理 CLI (Google Drive + age 暗号化)

使い方:
  gcloud-secrets init [drive-folder-id] --client-id <id> --client-secret <secret> [--env <default>]
                                                   初期設定 (OAuth + age 鍵 + Drive フォルダ)
  gcloud-secrets reauth                            OAuth token 再認証のみ (config は保持)
  gcloud-secrets list [folder] [--env <env>]       一覧表示
  gcloud-secrets pull [folder] [--env <env>]       シークレットを取得
  gcloud-secrets push [folder] [file] [--env <env>] シークレットをアップロード
  gcloud-secrets scan [basePath] [--env <env>]     Git リポジトリの .env 同期状況をスキャン
  gcloud-secrets search <keyword> [--env <env>]    値から逆引き検索
  gcloud-secrets pre-commit                        .env 自動同期 (git hook 用)
  gcloud-secrets key backup                        age 秘密鍵を暗号化して Drive にバックアップ
  gcloud-secrets key restore                       Drive から age 秘密鍵を復元
  gcloud-secrets hook install                      グローバル git hook インストール
  gcloud-secrets hook uninstall                    グローバル git hook アンインストール

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
