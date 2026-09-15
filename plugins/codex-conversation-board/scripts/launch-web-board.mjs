#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchWebBoard } from "../server/web-launcher.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestedPort = Number.parseInt(
  process.env.CODEX_BOARD_WEB_PORT ?? process.env.PORT ?? "4765",
  10,
);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536
  ? requestedPort
  : 4765;

try {
  const { url } = await launchWebBoard({ projectRoot, port });
  console.log(`对话看板已打开：${url}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`无法打开对话看板：${message}`);
  if (process.platform === "darwin" && process.env.CODEX_BOARD_SKIP_ALERT !== "1") {
    const script = `display alert "无法打开对话看板" message ${JSON.stringify(message)}`;
    execFile("/usr/bin/osascript", ["-e", script], () => {});
  }
  process.exitCode = 1;
}
