#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { homedir } from "os";

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

// gcloud コマンド実行
function runGcloud(args) {
  try {
    return execSync(`gcloud ${args}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
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
              description:
                "フォルダ名（省略時はフォルダ一覧を表示）",
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
              description:
                "フォルダ名（省略時はカレントディレクトリ名）",
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
              description:
                "フォルダ名（省略時はカレントディレクトリ名）",
            },
            envContent: {
              type: "string",
              description:
                ".env 形式の内容（KEY=VALUE の改行区切り）",
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
              description:
                "削除するキー名（省略時はフォルダ全体を削除）",
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

        // Secret Manager API 有効化
        try {
          runGcloud(
            `services enable secretmanager.googleapis.com --project=${projectId}`
          );
        } catch (e) {
          // 既に有効な場合は無視
        }

        // 設定ファイル作成
        const fs = await import("fs");
        fs.writeFileSync(configFile, `SECRETS_CENTRAL_PROJECT=${projectId}\n`);

        return {
          content: [
            {
              type: "text",
              text: `設定完了: ${projectId}\n設定ファイル: ${configFile}`,
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

        if (!folder) {
          // フォルダ一覧
          const output = runGcloud(
            `secrets list --project=${centralProject} --format="value(labels.folder)"`
          );
          const folders = [...new Set(output.split("\n").filter(Boolean))];
          return {
            content: [
              {
                type: "text",
                text: `フォルダ一覧:\n${folders.map((f) => `  ${f}/`).join("\n")}`,
              },
            ],
          };
        } else {
          // フォルダ内のシークレット一覧
          const output = runGcloud(
            `secrets list --project=${centralProject} --filter="labels.folder=${folder}" --format="value(name)"`
          );
          const secrets = output.split("\n").filter(Boolean);
          const keys = secrets.map((s) => getKeyFromSecret(s));
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

        // フォルダに属するシークレット一覧を取得
        const secretsList = runGcloud(
          `secrets list --project=${centralProject} --filter="labels.folder=${folder}" --format="value(name)"`
        );

        if (!secretsList) {
          return {
            content: [
              {
                type: "text",
                text: `フォルダ '${folder}' にシークレットが見つかりません`,
              },
            ],
          };
        }

        const secrets = secretsList.split("\n").filter(Boolean);
        const envLines = [];

        for (const secretName of secrets) {
          const key = getKeyFromSecret(secretName);
          const value = runGcloud(
            `secrets versions access latest --secret=${secretName} --project=${centralProject}`
          );
          envLines.push(`${key}=${value}`);
        }

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

        const folder = args.folder || currentFolder;
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

        const lines = envContent.split("\n");
        let count = 0;
        const results = [];

        for (const line of lines) {
          // 空行とコメント行をスキップ
          if (!line.trim() || line.trim().startsWith("#")) continue;

          const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (match) {
            const key = match[1];
            let value = match[2];

            // クォートを除去
            value = value.replace(/^["']|["']$/g, "");

            const secretName = makeSecretName(folder, key);

            try {
              // シークレットが存在するか確認
              runGcloud(
                `secrets describe ${secretName} --project=${centralProject}`
              );

              // 新しいバージョンを追加
              execSync(
                `echo -n "${value}" | gcloud secrets versions add ${secretName} --data-file=- --project=${centralProject} --quiet`,
                { encoding: "utf-8" }
              );
              results.push(`更新: ${key}`);
            } catch {
              // 新規作成
              runGcloud(
                `secrets create ${secretName} --replication-policy=automatic --labels=folder=${folder} --project=${centralProject} --quiet`
              );
              execSync(
                `echo -n "${value}" | gcloud secrets versions add ${secretName} --data-file=- --project=${centralProject} --quiet`,
                { encoding: "utf-8" }
              );
              results.push(`作成: ${key}`);
            }

            count++;
          }
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
          runGcloud(
            `secrets delete ${secretName} --project=${centralProject} --quiet`
          );
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
          const secretsList = runGcloud(
            `secrets list --project=${centralProject} --filter="labels.folder=${folder}" --format="value(name)"`
          );

          if (!secretsList) {
            return {
              content: [
                {
                  type: "text",
                  text: `フォルダ '${folder}' にシークレットが見つかりません`,
                },
              ],
            };
          }

          const secrets = secretsList.split("\n").filter(Boolean);
          for (const secretName of secrets) {
            runGcloud(
              `secrets delete ${secretName} --project=${centralProject} --quiet`
            );
          }

          return {
            content: [
              {
                type: "text",
                text: `削除: ${folder}/ (${secrets.length}件)`,
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

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
