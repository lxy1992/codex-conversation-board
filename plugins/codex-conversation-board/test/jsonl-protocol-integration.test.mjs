import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppServerClient } from "../server/app-server-client.js";
import { readJsonLines } from "../server/jsonl-reader.js";
import { McpProcessClient } from "../server/mcp-process-client.js";

const SERVER_PATH = new URL("../server/server.mjs", import.meta.url).pathname;

function waitForResponse(child, request, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`response ${request.id} timed out`)), timeoutMs);
    readJsonLines(child.stdout, (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== request.id) return;
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test("App Server responses keep U+2028 and U+2029 inside one JSONL message", async (t) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "codex-board-jsonl-"));
  const cliPath = join(fixtureDirectory, "fake-codex");
  await writeFile(cliPath, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id !== undefined) {
      process.stdout.write(JSON.stringify({
        id: request.id,
        result: { title: "first\\u2028second", preview: "first\\u2029second" },
      }) + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
`, "utf8");
  await chmod(cliPath, 0o755);

  const client = new AppServerClient({
    cliPath,
    requestTimeoutMs: 300,
    logger: { error() {} },
  });
  t.after(async () => {
    await client.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  await assert.doesNotReject(() => client.start());
});

test("MCP subprocess responses keep U+2028 and U+2029 inside one JSONL message", async (t) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "codex-board-mcp-jsonl-"));
  const serverPath = join(fixtureDirectory, "fake-server.mjs");
  await writeFile(serverPath, `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { title: "first\\u2028second", preview: "first\\u2029second" },
    }) + "\\n");
    newline = buffer.indexOf("\\n");
  }
});
`, "utf8");

  const client = new McpProcessClient({
    serverPath,
    cwd: fixtureDirectory,
    env: { ...process.env, CODEX_MCP_NODE_PATH: process.execPath },
    timeoutMs: 300,
    logger: { error() {} },
  });
  t.after(async () => {
    await client.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  await assert.doesNotReject(() => client.start());
});

test("MCP server input keeps U+2028 and U+2029 inside one JSONL message", async (t) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "codex-board-server-jsonl-"));
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      CODEX_HOME: fixtureDirectory,
      CODEX_BOARD_ENABLE_NATIVE_BROKER: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  const response = await waitForResponse(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "first\u2028second", title: "first\u2029second", version: "test" },
    },
  });

  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.equal(response.result.serverInfo.name, "codex-conversation-board");
});
