#!/usr/bin/env node

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// スキルのインストール先
const skillsDir = join(homedir(), ".claude", "skills");

// スキルディレクトリを作成
if (!existsSync(skillsDir)) {
  mkdirSync(skillsDir, { recursive: true });
}

// スキルファイルをコピー
const sourceDir = join(__dirname, "skills");
if (existsSync(sourceDir)) {
  const files = readdirSync(sourceDir);
  for (const file of files) {
    if (file.endsWith(".md")) {
      const src = join(sourceDir, file);
      const dest = join(skillsDir, file);
      copyFileSync(src, dest);
      console.log(`Installed skill: ${file} -> ${dest}`);
    }
  }
}

console.log("\ngcloud-secrets skills installed successfully!");
console.log("Use '/secrets' in Claude Code to see available commands.");
