#!/usr/bin/env node

import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// skill のインストール (~/.claude/skills/)
// ============================================================
const skillsDir = join(homedir(), ".claude", "skills");
if (!existsSync(skillsDir)) {
  mkdirSync(skillsDir, { recursive: true });
}

const skillsSrc = join(__dirname, "skills");
if (existsSync(skillsSrc)) {
  for (const file of readdirSync(skillsSrc)) {
    if (file.endsWith(".md")) {
      copyFileSync(join(skillsSrc, file), join(skillsDir, file));
      console.log(`Installed skill: ${file} -> ${skillsDir}/${file}`);
    }
  }
}

// 過去 install されたまま残っている duplicate slash command を掃除
// (commands/secrets.md は MCP 版時代の遺物、skill auto-trigger に一本化)
const dupCommand = join(homedir(), ".claude", "commands", "secrets.md");
if (existsSync(dupCommand)) {
  try {
    const content = readFileSync(dupCommand, "utf-8");
    // gcloud-secrets-mcp を指す古いやつだけ消す (user 自前で書いたものは保護)
    if (content.includes("gcloud-secrets-mcp")) {
      rmSync(dupCommand);
      console.log(`Removed stale slash command: ${dupCommand}`);
    }
  } catch {}
}

// ============================================================
// SessionStart hook のインストール (~/.claude/hooks/)
// ============================================================
const hooksDir = join(homedir(), ".claude", "hooks");
if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

const hooksSrc = join(__dirname, "hooks");
const installedHooks = [];
if (existsSync(hooksSrc)) {
  for (const file of readdirSync(hooksSrc)) {
    if (file.endsWith(".sh")) {
      const dest = join(hooksDir, file);
      copyFileSync(join(hooksSrc, file), dest);
      chmodSync(dest, 0o755);
      installedHooks.push(dest);
      console.log(`Installed hook: ${file} -> ${dest}`);
    }
  }
}

// ============================================================
// settings.json の SessionStart hook 登録 (idempotent)
// ============================================================
const settingsPath = join(homedir(), ".claude", "settings.json");
if (installedHooks.length > 0 && existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.hooks = settings.hooks || {};
    settings.hooks.SessionStart = settings.hooks.SessionStart || [
      { matcher: "", hooks: [] },
    ];
    const block = settings.hooks.SessionStart[0];
    block.hooks = block.hooks || [];

    let added = 0;
    for (const cmd of installedHooks) {
      if (!block.hooks.some((h) => h.command === cmd)) {
        block.hooks.push({ type: "command", command: cmd, timeout: 10 });
        added++;
      }
    }

    if (added > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log(`Registered ${added} hook(s) in ${settingsPath}`);
    } else {
      console.log(`Hooks already registered in ${settingsPath}`);
    }
  } catch (e) {
    console.warn(`Warning: could not update ${settingsPath}: ${e.message}`);
    console.warn(`手動で SessionStart に追加してください: ${installedHooks.join(", ")}`);
  }
}

// ============================================================
// ignore list の bootstrap (空テンプレ作成)
// ============================================================
const ignorePath = join(homedir(), ".secrets-manager-scan-ignore.txt");
if (!existsSync(ignorePath)) {
  writeFileSync(
    ignorePath,
    "# SessionStart hook (session-start-secret-scan.sh) の警告抑制リスト\n" +
      "# 1 行 1 プロジェクト名。空行と # 行は無視。\n" +
      "# 例: ndlocrlite-web   ← remote で .env tracked + 公開設計で warn が消えない場合\n"
  );
  console.log(`Bootstrap ignore list: ${ignorePath}`);
}

console.log("\ngcloud-secrets skills + hooks installed.");
console.log("Trigger keyword 'secrets' で skill auto-load、毎セッション開始時に backup 漏れ + auth 状況を報告。");
