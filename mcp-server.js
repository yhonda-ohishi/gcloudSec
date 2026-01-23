#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename } from "path";
import { homedir } from "os";

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

// シークレット名からフォルダを抽出
function getFolderFromSecret(secretName) {
  return secretName.split("_")[0];
}

const server = new Server(
  {
    name: "gcloud-secrets",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "secrets_list",
        description:
          "Secret Manager のフォルダ一覧、または指定フォルダ内のシークレット一覧を表示",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "フォルダ名(省略時はフォルダ一覧を表示)",
            },
          },
        },
      },
      {
        name: "secrets_pull",
        description:
          "Secret Manager からシークレットを取得して .env 形式で返す",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "フォルダ名(省略時はカレントディレクトリ名)",
            },
          },
        },
      },
      {
        name: "secrets_push",
        description:
          ".env / .dev.vars ファイルの内容を Secret Manager にアップロード",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "フォルダ名(省略時はカレントディレクトリ名)",
            },
            envContent: {
              type: "string",
              description: ".env 形式の内容(KEY=VALUE の改行区切り)",
            },
          },
          required: ["envContent"],
        },
      },
      {
        name: "secrets_delete",
        description: "シークレットを削除",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "フォルダ名",
            },
            key: {
              type: "string",
              description: "削除するキー名(省略時はフォルダ全体を削除)",
            },
          },
          required: ["folder"],
        },
      },
      {
        name: "secrets_init",
        description: "Secret Manager の中央プロジェクトを設定",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "GCP プロジェクトID",
            },
          },
          required: ["projectId"],
        },
      },
    ],
  };
});

// ツール実行
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const config = getConfig();
  const centralProject = config.centralProject;

  // カレントディレクトリ名を取得
  const currentFolder = basename(process.cwd());

  try {
    switch (name) {
      case "secrets_init": {
        const projectId = args.projectId;
        const configFile = `${homedir()}/.secrets-manager.conf`;

        // 設定ファイル作成
        writeFileSync(configFile, `SECRETS_CENTRAL_PROJECT=${projectId}\n`);

        return {
          content: [
            {
              type: "text",
              text: `設定完了: ${projectId}\n設定ファイル: ${configFile}\n\n注意: Secret Manager API が有効化されていることを確認してください。`,
            },
          ],
        };
      }

      case "secrets_list": {
        if (!centralProject) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: SECRETS_CENTRAL_PROJECT が設定されていません。secrets_init を実行してください。",
              },
            ],
            isError: true,
          };
        }

        const folder = args.folder;
        const parent = `projects/${centralProject}`;

        // シークレット一覧を取得
        const [secrets] = await client.listSecrets({ parent });

        if (!folder) {
          // フォルダ一覧
          const folders = new Set();
          for (const secret of secrets) {
            const labels = secret.labels || {};
            if (labels.folder) {
              folders.add(labels.folder);
            }
          }
          const folderList = [...folders].sort();
          return {
            content: [
              {
                type: "text",
                text: `フォルダ一覧:\n${folderList.map((f) => `  ${f}/`).join("\n")}`,
              },
            ],
          };
        } else {
          // フォルダ内のシークレット一覧
          const keys = [];
          for (const secret of secrets) {
            const labels = secret.labels || {};
            if (labels.folder === folder) {
              const secretName = secret.name.split("/").pop();
              keys.push(getKeyFromSecret(secretName));
            }
          }
          return {
            content: [
              {
                type: "text",
                text: `フォルダ '${folder}' のシークレット:\n${keys.map((k) => `  ${k}`).join("\n")}`,
              },
            ],
          };
        }
      }

      case "secrets_pull": {
        if (!centralProject) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: SECRETS_CENTRAL_PROJECT が設定されていません。secrets_init を実行してください。",
              },
            ],
            isError: true,
          };
        }

        const folder = args.folder || currentFolder;
        const parent = `projects/${centralProject}`;

        // シークレット一覧を取得
        const [secrets] = await client.listSecrets({ parent });

        // フォルダに属するシークレットをフィルタ
        const folderSecrets = secrets.filter((secret) => {
          const labels = secret.labels || {};
          return labels.folder === folder;
        });

        if (folderSecrets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `フォルダ '${folder}' にシークレットが見つかりません`,
              },
            ],
          };
        }

        // 全シークレットの値を並列で取得
        const envLines = await Promise.all(
          folderSecrets.map(async (secret) => {
            const secretName = secret.name.split("/").pop();
            const key = getKeyFromSecret(secretName);

            const [version] = await client.accessSecretVersion({
              name: `${secret.name}/versions/latest`,
            });

            const value = version.payload.data.toString("utf8");
            return `${key}=${value}`;
          })
        );

        return {
          content: [
            {
              type: "text",
              text: envLines.join("\n"),
            },
          ],
        };
      }

      case "secrets_push": {
        if (!centralProject) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: SECRETS_CENTRAL_PROJECT が設定されていません。secrets_init を実行してください。",
              },
            ],
            isError: true,
          };
        }

        const folderRaw = args.folder || currentFolder;
        // フォルダ名を小文字に変換（GCP ラベル制約対応）
        const folder = folderRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        const envContent = args.envContent;

        if (!envContent) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: envContent が必要です",
              },
            ],
            isError: true,
          };
        }

        // マルチライン値を解析（バッククォート対応）
        const entries = [];
        const multilineRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*`([\s\S]*?)`/gm;
        let remaining = envContent;
        let multiMatch;

        while ((multiMatch = multilineRegex.exec(envContent)) !== null) {
          entries.push({ key: multiMatch[1], value: multiMatch[2] });
          remaining = remaining.replace(multiMatch[0], '');
        }

        // 通常の単一行を解析
        const lines = remaining.split("\n");
        let count = 0;
        const results = [];

        for (const line of lines) {
          // 空行とコメント行をスキップ
          if (!line.trim() || line.trim().startsWith("#")) continue;

          // KEY = VALUE 形式も対応（行頭スペース、= 前後スペース許容）
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (match) {
            const key = match[1];
            let value = match[2];

            // クォートを除去
            value = value.replace(/^["']|["']$/g, "");
            entries.push({ key, value });
          }
        }

        // 全エントリをアップロード
        for (const { key, value } of entries) {

            const secretName = makeSecretName(folder, key);
            const secretPath = `projects/${centralProject}/secrets/${secretName}`;

            try {
              // シークレットが存在するか確認
              await client.getSecret({ name: secretPath });

              // 新しいバージョンを追加
              await client.addSecretVersion({
                parent: secretPath,
                payload: { data: Buffer.from(value, "utf8") },
              });
              results.push(`更新: ${key}`);
            } catch (e) {
              if (e.code === 5) {
                // NOT_FOUND - 新規作成
                await client.createSecret({
                  parent: `projects/${centralProject}`,
                  secretId: secretName,
                  secret: {
                    replication: { automatic: {} },
                    labels: { folder },
                  },
                });

                await client.addSecretVersion({
                  parent: secretPath,
                  payload: { data: Buffer.from(value, "utf8") },
                });
                results.push(`作成: ${key}`);
              } else {
                throw e;
              }
            }

          count++;
        }

        return {
          content: [
            {
              type: "text",
              text: `完了: ${count}件のシークレットをアップロードしました\n${results.join("\n")}`,
            },
          ],
        };
      }

      case "secrets_delete": {
        if (!centralProject) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: SECRETS_CENTRAL_PROJECT が設定されていません。secrets_init を実行してください。",
              },
            ],
            isError: true,
          };
        }

        const folder = args.folder;
        const key = args.key;

        if (!folder) {
          return {
            content: [
              {
                type: "text",
                text: "エラー: folder が必要です",
              },
            ],
            isError: true,
          };
        }

        if (key) {
          // 特定のキーを削除
          const secretName = makeSecretName(folder, key);
          await client.deleteSecret({
            name: `projects/${centralProject}/secrets/${secretName}`,
          });
          return {
            content: [
              {
                type: "text",
                text: `削除: ${folder}/${key}`,
              },
            ],
          };
        } else {
          // フォルダ全体を削除
          const parent = `projects/${centralProject}`;
          const [secrets] = await client.listSecrets({ parent });

          const folderSecrets = secrets.filter((secret) => {
            const labels = secret.labels || {};
            return labels.folder === folder;
          });

          if (folderSecrets.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `フォルダ '${folder}' にシークレットが見つかりません`,
                },
              ],
            };
          }

          // 全シークレットを並列で削除
          await Promise.all(
            folderSecrets.map((secret) =>
              client.deleteSecret({ name: secret.name })
            )
          );

          return {
            content: [
              {
                type: "text",
                text: `削除: ${folder}/ (${folderSecrets.length}件)`,
              },
            ],
          };
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `不明なツール: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `エラー: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

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
          console.error("使い方: gcloud-secrets-mcp init <project-id>");
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
            const name = secret.name.split("/").pop();
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
        const folder = args[1] || basename(process.cwd());
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
        const folder = args[1] || basename(process.cwd());
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

      default:
        console.log(`gcloud-secrets-mcp - GCP Secret Manager CLI

使い方:
  gcloud-secrets-mcp init <project-id>   中央プロジェクトを設定
  gcloud-secrets-mcp list [folder]       一覧表示
  gcloud-secrets-mcp pull [folder]       シークレットを取得
  gcloud-secrets-mcp push [folder] [file] シークレットをアップロード
`);
    }
  } catch (error) {
    console.error(`エラー: ${error.message}`);
    process.exit(1);
  }
}

// サーバー起動
async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // CLI モード
    await runCli(args);
  } else {
    // MCP サーバーモード
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);
