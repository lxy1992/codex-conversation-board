import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppServerClient } from "../server/app-server-client.js";
import { McpProcessClient } from "../server/mcp-process-client.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PEER = fileURLToPath(new URL("./fixtures/jsonl-peer.mjs", import.meta.url));
const TEXT = "first\u2028second\u2029中文😀";
const POSIX = { skip: process.platform === "win32", timeout: 10_000 };

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-jsonl-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliPath = join(directory, "codex");
  await writeFile(cliPath, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(PEER).href)};\n`);
  await chmod(cliPath, 0o755);
  // All storage and navigation paths belong to the fixture, even when this test
  // is run from a developer's signed-in environment. Never start a real CLI.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(CODEX_|CLAUDE_)/.test(key)));
  Object.assign(env, {
    HOME: directory,
    APPDATA: join(directory, "appdata"),
    CODEX_HOME: join(directory, ".codex"),
    CLAUDE_HOME: join(directory, ".claude"),
    CLAUDE_DESKTOP_SESSIONS_PATH: join(directory, "claude-desktop"),
    CODEX_CLI_PATH: cliPath,
    CODEX_MCP_NODE_PATH: process.execPath,
    CODEX_APP_TOOLS_PIPE_PATH: join(directory, "missing.sock"),
    CODEX_APP_TOOLS_PIPE_DIRECTORY: join(directory, "pipes"),
    CODEX_BOARD_ENABLE_NATIVE_BROKER: "0",
    CODEX_BOARD_WEB_PORT: "0",
  });
  return { directory, cliPath, env };
}

async function appClient(t) {
  const { cliPath } = await sandbox(t);
  const client = new AppServerClient({ cliPath, requestTimeoutMs: 2_000 });
  t.after(() => client.close());
  return client;
}

async function mcpClient(t) {
  const { env } = await sandbox(t);
  const client = new McpProcessClient({ serverPath: PEER, env, timeoutMs: 2_000 });
  t.after(() => client.close());
  return client;
}

test("App Server thread/list and notifications preserve Unicode across stdout chunks", POSIX, async (t) => {
  const client = await appClient(t);
  const notifications = [];
  const errors = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("protocol-error", (error) => errors.push(error));
  const threads = await client.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].name, TEXT);
  assert.equal(threads[0].preview, TEXT);
  assert.deepEqual(notifications, [{ method: "synthetic/event", params: { text: TEXT } }]);
  assert.deepEqual(errors, []);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.request("synthetic/error"), { message: TEXT });
});

test("App Server reports malformed records without payloads and still resolves the next response", POSIX, async (t) => {
  const client = await appClient(t);
  const errors = [];
  client.on("protocol-error", (error) => errors.push(error.message));
  await client.start();
  assert.equal((await client.request("synthetic/invalid")).text, TEXT);
  assert.equal(errors.length, 4);
  for (const message of errors) {
    assert.match(message, /^Invalid App Server (JSON|message)$/);
    assert.doesNotMatch(message, /synthetic-invalid/);
  }
  assert.equal(client.pending.size, 0);
});

test("App Server resolves an unterminated final stdout response", POSIX, async (t) => {
  const client = await appClient(t);
  await client.start();
  assert.equal((await client.request("synthetic/tail")).text, TEXT);
  assert.equal(client.pending.size, 0);
});

test("MCP child responses preserve Unicode, concurrent messages and request errors", { timeout: 10_000 }, async (t) => {
  const client = await mcpClient(t);
  await client.start();
  const results = await Promise.all([
    client.callTool("synthetic/echo", { text: TEXT }),
    client.callTool("synthetic/echo", { text: TEXT + "2" }),
  ]);
  assert.equal(results[0].text, TEXT);
  assert.deepEqual(results.map((result) => result.echo.arguments.text), [TEXT, TEXT + "2"]);
  await assert.rejects(client.callTool("synthetic/error"), { message: TEXT });
  assert.equal(client.pending.size, 0);
});

test("MCP child ignores malformed records and resolves the following response", { timeout: 10_000 }, async (t) => {
  const client = await mcpClient(t);
  assert.equal((await client.callTool("synthetic/invalid")).text, TEXT);
  assert.equal(client.pending.size, 0);
});

test("MCP child resolves an unterminated final stdout response", { timeout: 10_000 }, async (t) => {
  const client = await mcpClient(t);
  assert.equal((await client.callTool("synthetic/tail")).text, TEXT);
  assert.equal(client.pending.size, 0);
});

async function runServerInput(t, chunks) {
  const { env } = await sandbox(t);
  const child = spawn(process.execPath, [resolve(ROOT, "server/server.mjs")], { cwd: ROOT, env });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = once(child, "close");
  for (const chunk of chunks) {
    child.stdin.write(chunk);
    await setImmediate();
  }
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  // Independent oracle: collect bytes through EOF, then split exclusively on LF.
  return Buffer.concat(stdout).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("MCP stdin accepts Unicode, CRLF, multiple messages and a final message without LF", { timeout: 10_000 }, async (t) => {
  const request = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const bytes = Buffer.from([
    "\r\n  \n",
    request(1, "initialize", { protocolVersion: TEXT }) + "\r\n",
    request(TEXT, "ping") + "\n",
    request(3, "synthetic/" + TEXT) + "\n",
    JSON.stringify({ method: "notifications/initialized", params: { text: TEXT } }) + "\n",
    request(4, "initialize", { protocolVersion: TEXT }),
  ].join(""));
  const responses = await runServerInput(t, Array.from(bytes, (byte) => Buffer.from([byte])));
  assert.equal(responses.length, 4);
  assert.equal(responses.find(({ id }) => id === 1).result.protocolVersion, TEXT);
  assert.deepEqual(responses.find(({ id }) => id === TEXT).result, {});
  assert.deepEqual(responses.find(({ id }) => id === 3).error, { code: -32601, message: "不支持的方法：synthetic/" + TEXT });
  assert.equal(responses.find(({ id }) => id === 4).result.protocolVersion, TEXT);
});

test("MCP stdin rejects malformed JSON and non-object requests, then continues", { timeout: 10_000 }, async (t) => {
  const responses = await runServerInput(t, [Buffer.from(
    'synthetic-invalid\nnull\n42\n[]\n{"id":1,"method":"ping"}\n{"truncated":',
  )]);
  assert.equal(responses.length, 6);
  assert.equal(responses.filter((message) => message.error?.code === -32700).length, 2);
  assert.equal(responses.filter((message) => message.error?.code === -32600).length, 3);
  assert.deepEqual(responses.find(({ id }) => id === 1).result, {});
});

test("standalone web startup serves the board after a Unicode thread/list response", { ...POSIX, timeout: 15_000 }, async (t) => {
  const { env } = await sandbox(t);
  const child = spawn(process.execPath, [resolve(ROOT, "server/web.mjs")], { cwd: ROOT, env });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await closed;
    clearTimeout(timer);
  });
  child.stderr.resume();
  const url = await new Promise((resolveUrl, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`synthetic web server exited: ${code}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolveUrl(match[0]);
    });
  });
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /11111111-1111-4111-8111-111111111111/);
  assert.match(html, /first second 中文😀/);
});
