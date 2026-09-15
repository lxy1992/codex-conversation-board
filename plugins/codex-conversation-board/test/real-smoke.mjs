import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchDirectory = await mkdtemp(join(tmpdir(), "codex-board-real-smoke-"));
const child = spawn(process.execPath, [resolve(root, "server/server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    CODEX_CHATGPT_BOARD_STATE_PATH: join(scratchDirectory, "chatgpt-board.json"),
    CODEX_CHATGPT_BOARD_SNAPSHOT_PATH: join(scratchDirectory, "chatgpt-fast-snapshot.json"),
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const output = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

output.on("line", (line) => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (callback) {
    pending.delete(message.id);
    callback(message);
  }
});

function request(method, params = {}) {
  return new Promise((resolveRequest, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolveRequest(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "real-smoke", version: "1" },
  });
  const boardStartedAt = performance.now();
  const response = await request("tools/call", { name: "get_board", arguments: { force: true } });
  const boardMs = Math.round(performance.now() - boardStartedAt);
  const board = response.structuredContent;
  assert.ok(board.threads.length > 0, "expected real Codex conversations");
  assert.equal(board.columns.length, 6);
  assert.ok(board.projects.length > 0, "expected resolved Codex projects");
  assert.equal(board.donePreviewMode, "today");
  assert.equal(
    board.threads.filter((thread) => thread.boardStatus === "done").length,
    board.donePreviewCount,
  );
  assert.ok(boardMs < 1_000, `expected real board refresh under 1s, got ${boardMs}ms`);
  const threadIds = board.threads.slice(0, 200).map((thread) => thread.id);
  const activityStartedAt = performance.now();
  const activityResponse = await request("tools/call", {
    name: "get_thread_activity",
    arguments: { threadIds },
  });
  const activityMs = Math.round(performance.now() - activityStartedAt);
  assert.equal(Object.keys(activityResponse.structuredContent.activities).length, threadIds.length);
  assert.ok(activityMs < 1_000, `expected activity refresh under 1s, got ${activityMs}ms`);

  const chatGptStartedAt = performance.now();
  const chatGptResponse = await request("tools/call", {
    name: "get_board",
    arguments: { source: "chatgpt", force: true },
  });
  const chatGptMs = Math.round(performance.now() - chatGptStartedAt);
  const chatGptBoard = chatGptResponse.structuredContent;
  assert.equal(chatGptBoard.source, "chatgpt");
  assert.ok(chatGptBoard.total > 0, "expected real ChatGPT conversations");
  assert.ok(
    chatGptBoard.threads.every((thread) => thread.conversationKind === "chatgpt"),
    "expected only ChatGPT cards in the ChatGPT tab",
  );
  assert.ok(chatGptMs < 1_000, `expected real ChatGPT board refresh under 1s, got ${chatGptMs}ms`);
  process.stdout.write(
    `${JSON.stringify({
      codex: {
        threads: board.threads.length,
        todayDone: board.donePreviewCount,
        projects: board.projects.length,
        boardMs,
        activityMs,
      },
      chatgpt: {
        returnedThreads: chatGptBoard.threads.length,
        total: chatGptBoard.total,
        boardMs: chatGptMs,
      },
      columns: board.columns.length,
    })}\n`,
  );
} finally {
  child.stdin.end();
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  await rm(scratchDirectory, { recursive: true, force: true });
}
