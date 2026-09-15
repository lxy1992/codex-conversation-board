#!/usr/bin/env node

import { execFile } from "node:child_process";
import { McpProcessClient } from "./mcp-process-client.js";
import { createBoardWebServer } from "./web-server.js";

const host = "127.0.0.1";
const requestedPort = Number.parseInt(
  process.env.CODEX_BOARD_WEB_PORT ?? process.env.PORT ?? "4765",
  10,
);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort < 65_536
  ? requestedPort
  : 4765;
const shouldOpen = process.argv.includes("--open");

function openBrowser(url, callback) {
  if (process.platform === "darwin") {
    execFile("/usr/bin/open", [url], callback);
    return;
  }
  if (process.platform === "win32") {
    execFile("explorer.exe", [url], callback);
    return;
  }
  execFile("xdg-open", [url], callback);
}

const mcp = new McpProcessClient();
await mcp.start();
await mcp.callTool("show_board", { force: false });

const server = createBoardWebServer({
  callTool: (name, args) => mcp.callTool(name, args),
});

server.on("error", (error) => {
  console.error(`网页版看板启动失败：${error.message}`);
  process.exitCode = 1;
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, host, () => {
    server.off("error", rejectListen);
    resolveListen();
  });
});

const address = server.address();
const url = `http://${host}:${address.port}`;
console.log(`Codex 对话看板网页版已启动：${url}`);
if (shouldOpen) {
  openBrowser(url, (error) => {
    if (error) console.error(`无法自动打开浏览器：${error.message}`);
  });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise((resolveClose) => server.close(resolveClose));
  await mcp.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}
