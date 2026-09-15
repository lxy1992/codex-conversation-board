import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI_URI = "ui://codex-conversation-board/board.html";
const SAMPLE_COUNT = Number(process.env.CODEX_BOARD_BENCHMARK_SAMPLES || 20);
const TARGET_P95_MS = Number(process.env.CODEX_BOARD_TARGET_P95_MS || 1_000);

function representativeSnapshot() {
  const columns = [
    ["inbox", "收件箱"],
    ["todo", "待处理"],
    ["doing", "进行中"],
    ["blocked", "阻塞"],
    ["review", "待验收"],
    ["done", "完成"],
  ].map(([id, label]) => ({ id, label }));
  const threads = Array.from({ length: 40 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const unread = index % 7 === 0;
    return {
      id,
      title: `代表性 Codex 对话 ${index + 1}`,
      project: { id: "local-project", name: "本机项目" },
      runtime: { state: "idle", label: "" },
      activity: {
        state: unread ? "unread" : "idle",
        label: unread ? "新回复未读" : "",
        unread,
        startedAt: null,
        completedAt: "2026-08-28T00:00:00.000Z",
      },
      updatedAt: "2026-08-28T00:00:00.000Z",
      branch: null,
      openUrl: `codex://threads/${id}`,
      boardStatus: index % 5 === 0 ? "doing" : "inbox",
      boardPosition: index,
    };
  });
  return {
    snapshotVersion: 2,
    generatedAt: "2026-08-28T00:00:00.000Z",
    activitySourceVersion: 2,
    columns,
    projects: [{ id: "local-project", name: "本机项目", count: threads.length }],
    threads,
    total: 954,
    columnCounts: { inbox: 32, todo: 0, doing: 8, blocked: 0, review: 0, done: 914 },
    doneLoaded: false,
    donePreviewMode: "today",
    donePreviewDate: "2026-08-28",
    donePreviewCount: 0,
    runtimeStatusNote: "",
    activityStatusNote: "",
  };
}

async function measureOnce(snapshotPath) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [resolve(ROOT, "server/server.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODEX_BOARD_SNAPSHOT_PATH: snapshotPath },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    callback(message);
  });

  function request(method, params = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`MCP request timed out: ${method}`));
      }, TARGET_P95_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) rejectRequest(new Error(message.error.message));
        else resolveRequest(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    await request("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const { tools } = await request("tools/list");
    const showTool = tools.find((tool) => tool.name === "show_board");
    assert.equal(showTool?._meta?.["openai/outputTemplate"], UI_URI);

    const showResult = await request("tools/call", { name: "show_board", arguments: {} });
    assert.equal(showResult.structuredContent?.ready, true);

    const resource = await request("resources/read", { uri: UI_URI });
    assert.equal(resource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /<script id="boardBootstrap" type="application\/json">\{/);
    return {
      totalMs: performance.now() - startedAt,
      resourceBytes: Buffer.byteLength(resource.contents[0].text),
    };
  } finally {
    child.kill("SIGTERM");
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

const directory = await mkdtemp(join(tmpdir(), "codex-board-performance-"));
const snapshotPath = join(directory, "snapshot.json");
await writeFile(snapshotPath, `${JSON.stringify(representativeSnapshot())}\n`, "utf8");

const samples = [];
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
  samples.push(await measureOnce(snapshotPath));
}
const durations = samples.map(({ totalMs }) => totalMs);
const result = {
  scenario: "fresh MCP process -> initialize -> tools/list -> show_board -> resources/read",
  samples: SAMPLE_COUNT,
  resourceBytes: samples[0].resourceBytes,
  medianMs: Math.round(percentile(durations, 0.5) * 10) / 10,
  p95Ms: Math.round(percentile(durations, 0.95) * 10) / 10,
  maxMs: Math.round(percentile(durations, 1) * 10) / 10,
  targetP95Ms: TARGET_P95_MS,
};
console.log(JSON.stringify(result));
assert.ok(result.p95Ms < TARGET_P95_MS, `MCP App launch path p95 ${result.p95Ms}ms exceeded ${TARGET_P95_MS}ms`);
