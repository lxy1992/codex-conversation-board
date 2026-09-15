import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

function encodeNativeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function createClient(env = {}) {
  const child = spawn(process.execPath, [resolve(ROOT, "server/server.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_BOARD_SNAPSHOT_PATH: join(
        tmpdir(),
        `codex-board-snapshot-${process.pid}-${Date.now()}-${Math.random()}.json`,
      ),
      ...env,
    },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      callback(message);
    }
  });

  return {
    child,
    request(method, params = {}) {
      return new Promise((resolveRequest, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 5000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message));
          else resolveRequest(message.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      child.stdin.end();
      await once(child, "exit");
    },
  };
}

test("MCP server advertises the board tools and UI resource", async () => {
  const client = createClient();
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    assert.equal(initialized.serverInfo.name, "codex-conversation-board");

    const { tools } = await client.request("tools/list");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "show_board",
        "get_fast_snapshot",
        "get_board",
        "get_thread_activity",
        "move_thread",
        "update_board_columns",
        "open_thread",
      ],
    );
    assert.equal(tools[0]._meta["openai/outputTemplate"], "ui://codex-conversation-board/board.html");
    assert.deepEqual(tools[1]._meta.ui.visibility, ["app"]);
    assert.equal(tools[1]._meta["openai/widgetAccessible"], true);
    assert.equal(tools.find((tool) => tool.name === "open_thread").annotations.readOnlyHint, true);
    const activityTool = tools.find((tool) => tool.name === "get_thread_activity");
    assert.deepEqual(activityTool._meta.ui.visibility, ["app"]);
    assert.equal(activityTool.annotations.readOnlyHint, false);
    assert.equal(activityTool.inputSchema.properties.metadataThreadIds.maxItems, 200);
    assert.deepEqual(tools[0].inputSchema.properties.source.enum, ["codex", "chatgpt", "claude"]);

    const emptySnapshot = await client.request("tools/call", {
      name: "get_fast_snapshot",
      arguments: {},
    });
    assert.equal(emptySnapshot.structuredContent.activitySourceVersion, 2);
    assert.deepEqual(emptySnapshot.structuredContent.threads, []);

    const { resources } = await client.request("resources/list");
    assert.equal(resources[0].uri, "ui://codex-conversation-board/board.html");

    const resource = await client.request("resources/read", { uri: resources[0].uri });
    assert.match(resource.contents[0].mimeType, /text\/html/);
    assert.match(resource.contents[0].text, /Codex 对话看板/);
    assert.match(resource.contents[0].text, /requestDisplayMode/);
    assert.match(resource.contents[0].text, /move_thread/);
    assert.doesNotMatch(resource.contents[0].text, /__CODEX_BOARD_BOOTSTRAP__/);
  } finally {
    await client.close();
  }
});

test("open_thread routes ChatGPT cards to the Codex native navigator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-chatgpt-native-open-"));
  const pipePath = join(directory, "app-tools.sock");
  const nativeCalls = [];
  const nativeServer = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (pending.length < length + 4) return;
        const request = JSON.parse(pending.subarray(4, length + 4).toString("utf8"));
        pending = pending.subarray(length + 4);
        if (request.method === "tools/list") {
          socket.write(encodeNativeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [{ name: "navigate_to_codex_page", namespace: "codex_app" }],
            },
          }));
        } else if (request.method === "tools/call") {
          nativeCalls.push(request.params);
          socket.write(encodeNativeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              contentItems: [{ type: "inputText", text: '{"navigated":true}' }],
              success: true,
            },
          }));
        }
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    nativeServer.once("error", rejectListen);
    nativeServer.listen(pipePath, resolveListen);
  });
  const client = createClient({
    CODEX_APP_TOOLS_PIPE_PATH: pipePath,
    CODEX_THREAD_ID: FIRST,
    CODEX_BOARD_NATIVE_NAVIGATION_PATH: join(directory, "native-navigation.json"),
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const response = await client.request("tools/call", {
      name: "open_thread",
      arguments: { source: "chatgpt", threadId: SECOND },
      _meta: { "openai/threadId": FIRST, "openai/turnId": "turn-1" },
    });
    assert.equal(response.structuredContent.navigation, "codex-app");
    assert.equal(response.structuredContent.url, null);
    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0].arguments.threadId, SECOND);
    assert.equal(nativeCalls[0].threadId, FIRST);
  } finally {
    await client.close();
    await new Promise((resolveClose) => nativeServer.close(resolveClose));
  }
});

test("ChatGPT uses its own tab data and board state, then reopens updated completed chats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-chatgpt-source-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const globalStatePath = join(directory, "global-state.json");
  const chatGptBoardPath = join(directory, "chatgpt-board.json");
  const database = new DatabaseSync(catalogPath);
  database.exec(`
    CREATE TABLE local_thread_catalog (
      host_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_title TEXT NOT NULL,
      source_created_at REAL NOT NULL,
      source_updated_at REAL NOT NULL,
      source_recency_at REAL NOT NULL,
      source_kind TEXT NOT NULL,
      project_id TEXT,
      missing_candidate INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(`
    INSERT INTO local_thread_catalog (
      host_id, thread_id, display_title, source_created_at, source_updated_at,
      source_recency_at, source_kind, project_id, missing_candidate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const initialRecency = Date.now() / 1_000 - 60;
  insert.run("chatgpt:test", FIRST, "ChatGPT first", initialRecency, initialRecency, initialRecency, "chatgpt", "g-p-test");
  insert.run("chatgpt:test", SECOND, "ChatGPT second", initialRecency - 1, initialRecency - 1, initialRecency - 1, "chatgpt", null);
  database.close();
  await writeFile(globalStatePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "chatgpt-sidebar-state-v1": {
        test: {
          projects: [{ id: "g-p-test", name: "测试项目" }],
          pinnedConversations: [{ conversation: { id: FIRST } }],
        },
      },
    },
  }));

  const client = createClient({
    CODEX_CHATGPT_CATALOG_PATH: catalogPath,
    CODEX_CHATGPT_BOARD_STATE_PATH: chatGptBoardPath,
    CODEX_CHATGPT_BOARD_SNAPSHOT_PATH: join(directory, "chatgpt-snapshot.json"),
    CODEX_BOARD_STATE_PATH: join(directory, "codex-board.json"),
    CODEX_GLOBAL_STATE_PATH: globalStatePath,
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const response = await client.request("tools/call", {
      name: "get_board",
      arguments: { source: "chatgpt", force: true },
    });
    assert.equal(response.structuredContent.source, "chatgpt");
    assert.equal(response.structuredContent.total, 2);
    assert.equal(response.structuredContent.threads[0].project.name, "测试项目");
    assert.equal(response.structuredContent.threads[0].openUrl, null);
    assert.equal(response.structuredContent.columnCounts.todo, 1);
    assert.equal(response.structuredContent.columnCounts.done, 1);
    assert.equal(
      response.structuredContent.threads.find((thread) => thread.id === FIRST).boardStatus,
      "todo",
    );

    const configured = await client.request("tools/call", {
      name: "update_board_columns",
      arguments: {
        source: "chatgpt",
        columns: [
          ...response.structuredContent.columns.slice(0, -1),
          { id: "waiting-release", label: "等待发布", description: "等待上线", color: "#D97706" },
          response.structuredContent.columns.at(-1),
        ].map(({ id, label, description, color }) => ({ id, label, description, color })),
      },
    });
    assert.deepEqual(
      configured.structuredContent.columns.map(({ id }) => id),
      ["inbox", "todo", "doing", "blocked", "review", "waiting-release", "done"],
    );
    assert.equal(configured.structuredContent.settingsUpdate.migratedThreadIds.length, 0);

    await client.request("tools/call", {
      name: "move_thread",
      arguments: { source: "chatgpt", threadId: FIRST, status: "done" },
    });
    const afterMove = JSON.parse(await readFile(chatGptBoardPath, "utf8"));
    assert.deepEqual(afterMove.columns.done, [SECOND, FIRST]);

    const update = new DatabaseSync(catalogPath);
    const updatedRecency = Date.now() / 1_000 + 2;
    update.prepare(`
      UPDATE local_thread_catalog
      SET source_updated_at = ?, source_recency_at = ?
      WHERE thread_id = ?
    `).run(updatedRecency, updatedRecency, FIRST);
    update.close();

    const activity = await client.request("tools/call", {
      name: "get_thread_activity",
      arguments: { source: "chatgpt", threadIds: [SECOND] },
    });
    assert.deepEqual(activity.structuredContent.reopenedThreadIds, [FIRST]);
    assert.equal(activity.structuredContent.activities[SECOND].state, "idle");
    const afterReply = JSON.parse(await readFile(chatGptBoardPath, "utf8"));
    assert.deepEqual(afterReply.columns.done, [SECOND]);
    assert.deepEqual(afterReply.columns.inbox, [FIRST]);
  } finally {
    await client.close();
  }
});

test("Claude uses a separate board and reopens a completed session after local activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-claude-source-"));
  const desktopRoot = join(directory, "claude-desktop");
  const cliProjectsRoot = join(directory, "claude-cli-projects");
  const metadataDirectory = join(desktopRoot, "account", "workspace");
  const cliProject = join(cliProjectsRoot, "project");
  const claudeBoardPath = join(directory, "claude-board.json");
  const desktopId = "local_44444444-4444-4444-8444-444444444444";
  const cliId = "55555555-5555-4555-8555-555555555555";
  await Promise.all([
    mkdir(metadataDirectory, { recursive: true }),
    mkdir(cliProject, { recursive: true }),
  ]);
  const desktopPath = join(metadataDirectory, `${desktopId}.json`);
  const desktopMetadata = {
    sessionId: desktopId,
    cwd: "/work/claude-desktop",
    title: "Claude Desktop first",
    createdAt: Date.now() - 120_000,
    lastActivityAt: Date.now() - 60_000,
    isArchived: false,
  };
  await writeFile(desktopPath, JSON.stringify(desktopMetadata));
  await writeFile(join(cliProject, "sessions-index.json"), JSON.stringify({
    version: 1,
    originalPath: "/work/claude-cli",
    entries: [{
      sessionId: cliId,
      summary: "Claude CLI second",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      projectPath: "/work/claude-cli",
      isSidechain: false,
    }],
  }));

  const client = createClient({
    CLAUDE_DESKTOP_SESSIONS_PATH: desktopRoot,
    CLAUDE_CLI_PROJECTS_PATH: cliProjectsRoot,
    CODEX_CLAUDE_BOARD_STATE_PATH: claudeBoardPath,
    CODEX_CLAUDE_BOARD_SNAPSHOT_PATH: join(directory, "claude-snapshot.json"),
    CODEX_BOARD_STATE_PATH: join(directory, "codex-board.json"),
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const response = await client.request("tools/call", {
      name: "get_board",
      arguments: { source: "claude", force: true, includeDone: true },
    });
    assert.equal(response.structuredContent.source, "claude");
    assert.equal(response.structuredContent.total, 2);
    assert.equal(response.structuredContent.columnCounts.done, 2);
    assert.equal(response.structuredContent.sourceDiagnostics.desktop.loaded, 1);
    assert.equal(response.structuredContent.sourceDiagnostics.cli.loaded, 1);
    assert.equal(
      response.structuredContent.threads.find((thread) => thread.id === desktopId).openUrl,
      `claude://code/continue?session=${desktopId}`,
    );

    await client.request("tools/call", {
      name: "move_thread",
      arguments: { source: "claude", threadId: desktopId, status: "todo" },
    });
    await client.request("tools/call", {
      name: "move_thread",
      arguments: { source: "claude", threadId: desktopId, status: "done" },
    });
    desktopMetadata.lastActivityAt = Date.now() + 2_000;
    await writeFile(desktopPath, JSON.stringify(desktopMetadata));
    const activity = await client.request("tools/call", {
      name: "get_thread_activity",
      arguments: { source: "claude", threadIds: [cliId] },
    });
    assert.deepEqual(activity.structuredContent.reopenedThreadIds, [desktopId]);
    const afterReply = JSON.parse(await readFile(claudeBoardPath, "utf8"));
    assert.deepEqual(afterReply.columns.inbox, [desktopId]);
  } finally {
    await client.close();
  }
});

test("show_board rebuilds a legacy snapshot that has no card activity status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-legacy-snapshot-"));
  const fakeServerPath = join(directory, "fake-app-server.mjs");
  const fakeCliPath = join(directory, "codex");
  const boardPath = join(directory, "board.json");
  const snapshotPath = join(directory, "snapshot.json");
  await writeFile(
    fakeServerPath,
    `
      import { createInterface } from "node:readline";
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === "thread/list"
          ? { data: [{ id: ${JSON.stringify(FIRST)}, name: "first", cwd: ${JSON.stringify(directory)}, status: { type: "idle" } }], nextCursor: null }
          : {};
        process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
      });
    `,
    "utf8",
  );
  await writeFile(
    fakeCliPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServerPath)} "$@"\n`,
    "utf8",
  );
  await chmod(fakeCliPath, 0o755);
  await writeFile(
    boardPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: null,
      columns: { inbox: [], todo: [], doing: [FIRST], blocked: [], review: [], done: [] },
    })}\n`,
    "utf8",
  );
  await writeFile(
    snapshotPath,
    `${JSON.stringify({
      generatedAt: "2026-08-28T00:00:00.000Z",
      columns: [{ id: "doing", label: "进行中" }],
      projects: [],
      threads: [{
        id: FIRST,
        title: "first",
        project: { id: "legacy", name: "legacy" },
        boardStatus: "doing",
        boardPosition: 0,
      }],
      total: 1,
      columnCounts: { inbox: 0, todo: 0, doing: 1, blocked: 0, review: 0, done: 0 },
      doneLoaded: false,
    })}\n`,
    "utf8",
  );

  const client = createClient({
    CODEX_CLI_PATH: fakeCliPath,
    CODEX_BOARD_STATE_PATH: boardPath,
    CODEX_BOARD_SNAPSHOT_PATH: snapshotPath,
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const response = await client.request("tools/call", {
      name: "show_board",
      arguments: {},
    });
    assert.equal(response.structuredContent.activitySourceVersion, 2);
    assert.equal(response.structuredContent.threads[0].activity.state, "idle");
  } finally {
    await client.close();
  }
});

test("activity polling reopens a completed conversation when Codex marks a new reply unread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-reopen-unread-"));
  const boardPath = join(directory, "board.json");
  const globalStatePath = join(directory, "global-state.json");
  const catalogPath = join(directory, "catalog.sqlite");
  const database = new DatabaseSync(catalogPath);
  database.exec(`
    CREATE TABLE local_thread_catalog (
      host_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_title TEXT NOT NULL,
      source_created_at REAL NOT NULL,
      source_updated_at REAL NOT NULL,
      source_recency_at REAL NOT NULL,
      source_kind TEXT NOT NULL,
      missing_candidate INTEGER NOT NULL DEFAULT 0
    );
  `);
  database.prepare(`
    INSERT INTO local_thread_catalog (
      host_id, thread_id, display_title, source_created_at, source_updated_at,
      source_recency_at, source_kind, missing_candidate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run("local", FIRST, "刚刚改名的对话", 1, 2, 2, "vscode");
  database.close();
  await writeFile(
    boardPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: null,
      columns: { inbox: [], todo: [], doing: [], blocked: [], review: [], done: [FIRST] },
    })}\n`,
  );
  await writeFile(globalStatePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: [FIRST] },
    },
  }));

  const client = createClient({
    CODEX_BOARD_STATE_PATH: boardPath,
    CODEX_GLOBAL_STATE_PATH: globalStatePath,
    CODEX_BOARD_ACTIVITY_PATH: join(directory, "activity.json"),
    CODEX_THREAD_CATALOG_PATH: catalogPath,
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const firstPoll = await client.request("tools/call", {
      name: "get_thread_activity",
      arguments: { threadIds: [], metadataThreadIds: [FIRST] },
    });
    assert.deepEqual(firstPoll.structuredContent.reopenedThreadIds, [FIRST]);
    assert.deepEqual(firstPoll.structuredContent.threadMetadata, {
      [FIRST]: { title: "刚刚改名的对话" },
    });
    const persisted = JSON.parse(await readFile(boardPath, "utf8"));
    assert.deepEqual(persisted.columns.inbox, [FIRST]);
    assert.deepEqual(persisted.columns.done, []);

    const secondPoll = await client.request("tools/call", {
      name: "get_thread_activity",
      arguments: { threadIds: [] },
    });
    assert.deepEqual(secondPoll.structuredContent.reopenedThreadIds, []);
  } finally {
    await client.close();
  }
});

test("default board data includes only completed conversations from today", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-today-done-"));
  const fakeServerPath = join(directory, "fake-app-server.mjs");
  const fakeCliPath = join(directory, "codex");
  const boardPath = join(directory, "board.json");
  const today = Date.now();
  const old = today - 3 * 24 * 60 * 60 * 1_000;
  await writeFile(
    fakeServerPath,
    `
      import { createInterface } from "node:readline";
      const threads = ${JSON.stringify([
        { id: FIRST, name: "active", cwd: directory, status: { type: "idle" }, updatedAt: today },
        { id: SECOND, name: "done today", cwd: directory, status: { type: "idle" }, updatedAt: today },
        { id: THIRD, name: "done before today", cwd: directory, status: { type: "idle" }, updatedAt: old },
      ])};
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === "thread/list" ? { data: threads, nextCursor: null } : {};
        process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
      });
    `,
    "utf8",
  );
  await writeFile(
    fakeCliPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServerPath)} "$@"\n`,
    "utf8",
  );
  await chmod(fakeCliPath, 0o755);
  await writeFile(
    boardPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: null,
      columns: {
        inbox: [],
        todo: [],
        doing: [FIRST],
        blocked: [],
        review: [],
        done: [SECOND, THIRD],
      },
    })}\n`,
  );

  const client = createClient({
    CODEX_CLI_PATH: fakeCliPath,
    CODEX_BOARD_STATE_PATH: boardPath,
    CODEX_BOARD_ACTIVITY_PATH: join(directory, "activity.json"),
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const response = await client.request("tools/call", {
      name: "get_board",
      arguments: { force: false, includeDone: false },
    });
    const board = response.structuredContent;
    assert.equal(board.doneLoaded, false);
    assert.equal(board.donePreviewMode, "today");
    assert.equal(board.donePreviewCount, 1);
    assert.equal(board.columnCounts.done, 2);
    assert.deepEqual(new Set(board.threads.map(({ id }) => id)), new Set([FIRST, SECOND]));
  } finally {
    await client.close();
  }
});

test("get_board force refresh reloads externally changed lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-mcp-"));
  const fakeServerPath = join(directory, "fake-app-server.mjs");
  const fakeCliPath = join(directory, "codex");
  const boardPath = join(directory, "board.json");
  await writeFile(
    fakeServerPath,
    `
      import { createInterface } from "node:readline";
      const threads = ${JSON.stringify([
        { id: FIRST, name: "first", cwd: directory, status: { type: "idle" } },
        { id: SECOND, name: "second", cwd: directory, status: { type: "idle" } },
      ])};
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === "thread/list"
          ? { data: threads, nextCursor: null }
          : {};
        process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
      });
    `,
    "utf8",
  );
  await writeFile(
    fakeCliPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServerPath)} "$@"\n`,
    "utf8",
  );
  await chmod(fakeCliPath, 0o755);
  await writeFile(
    boardPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: null,
      columns: {
        inbox: [],
        todo: [],
        doing: [FIRST],
        blocked: [],
        review: [],
        done: [],
      },
    })}\n`,
    "utf8",
  );

  const client = createClient({
    CODEX_CLI_PATH: fakeCliPath,
    CODEX_BOARD_STATE_PATH: boardPath,
    HOME: directory,
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    await client.request("tools/call", { name: "get_board", arguments: {} });

    await writeFile(
      boardPath,
      `${JSON.stringify({
        version: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
        columns: {
          inbox: [],
          todo: [],
          doing: [],
          blocked: [],
          review: [],
          done: [FIRST, SECOND],
        },
      })}\n`,
      "utf8",
    );

    const lazyResponse = await client.request("tools/call", {
      name: "get_board",
      arguments: { force: true },
    });
    assert.equal(lazyResponse.structuredContent.doneLoaded, false);
    assert.equal(lazyResponse.structuredContent.columnCounts.done, 2);
    assert.deepEqual(lazyResponse.structuredContent.threads, []);

    const response = await client.request("tools/call", {
      name: "get_board",
      arguments: { force: true, includeDone: true },
    });
    assert.equal(response.structuredContent.doneLoaded, true);
    assert.deepEqual(
      response.structuredContent.threads.map(({ id, boardStatus }) => ({ id, boardStatus })),
      [
        { id: FIRST, boardStatus: "done" },
        { id: SECOND, boardStatus: "done" },
      ],
    );

    const showResponse = await client.request("tools/call", {
      name: "show_board",
      arguments: {},
    });
    assert.equal(showResponse.structuredContent.ready, true);
    assert.ok(Array.isArray(showResponse.structuredContent.columns));
    assert.ok(Array.isArray(showResponse.structuredContent.threads));

    const resource = await client.request("resources/read", {
      uri: "ui://codex-conversation-board/board.html",
    });
    assert.match(resource.contents[0].text, /"done":2/);
  } finally {
    await client.close();
  }
});
