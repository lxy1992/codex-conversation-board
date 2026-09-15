#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Skipping macOS native app typecheck on this platform.");
  process.exit(0);
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(projectRoot, "macos", "ConversationBoardApp.swift");
const moduleCachePath = path.join(tmpdir(), "codex-conversation-board-swift-module-cache");
mkdirSync(moduleCachePath, { recursive: true });
const result = spawnSync("/usr/bin/xcrun", [
  "swiftc",
  "-typecheck",
  "-parse-as-library",
  "-module-cache-path", moduleCachePath,
  "-swift-version", "5",
  "-framework", "AppKit",
  "-framework", "WebKit",
  sourcePath,
], { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
