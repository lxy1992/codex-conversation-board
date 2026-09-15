#!/usr/bin/env node

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const appPath = process.env.CODEX_BOARD_APP_PATH
  ?? path.join(homedir(), "Applications", "AI 对话看板.app");
rmSync(appPath, { recursive: true, force: true });
console.log(`已移除一键启动 App：${appPath}`);
