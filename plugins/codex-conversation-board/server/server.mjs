#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AppServerClient } from "./app-server-client.js";
import { BoardStore } from "./board-store.js";
import { ChatGptThreadService } from "./chatgpt-thread-service.js";
import { ClaudeThreadService, claudeOpenUrl } from "./claude-thread-service.js";
import { CodexAppNavigator } from "./codex-app-navigator.js";
import { CodexThreadMetadataService } from "./codex-thread-metadata.js";
import { ExternalUrlOpener } from "./external-url-opener.js";
import { NativeNavigationBroker } from "./native-navigation-broker.js";
import {
  BOARD_COLUMNS,
  BOARD_SOURCES,
  BOARD_SOURCE_IDS,
  isConversationId,
} from "./constants.js";
import { ProjectResolver } from "./project-resolver.js";
import {
  SnapshotStore,
  SNAPSHOT_ACTIVITY_SOURCE_VERSION,
  SNAPSHOT_VERSION,
} from "./snapshot-store.js";
import { ThreadActivityTracker } from "./thread-activity.js";
import { ThreadService } from "./thread-service.js";
import { isSameLocalDay, localDateKey, startOfLocalDayMs } from "./time.js";

const SERVER_VERSION = "0.8.2";
const ACTIVITY_SOURCE_VERSION = SNAPSHOT_ACTIVITY_SOURCE_VERSION;
const UI_URI = "ui://codex-conversation-board/board.html";
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PATH = resolve(ROOT_DIR, "ui/board.html");
const CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");
const BOARD_DATA_DIR = resolve(CODEX_HOME, "conversation-board");

const logger = {
  error: (...args) => process.stderr.write(`${args.join(" ")}\n`),
};

const appServer = new AppServerClient({ logger });
const boardStore = new BoardStore();
const chatGptBoardStore = new BoardStore({
  filePath: process.env.CODEX_CHATGPT_BOARD_STATE_PATH || resolve(BOARD_DATA_DIR, "chatgpt-board.json"),
});
const claudeBoardStore = new BoardStore({
  filePath: process.env.CODEX_CLAUDE_BOARD_STATE_PATH || resolve(BOARD_DATA_DIR, "claude-board.json"),
});
const projectResolver = new ProjectResolver({ logger });
const threadService = new ThreadService({ appServer, projectResolver });
const codexThreadMetadataService = new CodexThreadMetadataService({ logger });
const chatGptThreadService = new ChatGptThreadService();
const claudeThreadService = new ClaudeThreadService();
const snapshotStore = new SnapshotStore();
const chatGptSnapshotStore = new SnapshotStore({
  filePath: process.env.CODEX_CHATGPT_BOARD_SNAPSHOT_PATH || resolve(BOARD_DATA_DIR, "chatgpt-fast-snapshot.json"),
});
const claudeSnapshotStore = new SnapshotStore({
  filePath: process.env.CODEX_CLAUDE_BOARD_SNAPSHOT_PATH || resolve(BOARD_DATA_DIR, "claude-fast-snapshot.json"),
});
const activityTracker = new ThreadActivityTracker();
const codexAppNavigator = new CodexAppNavigator({ logger });
const externalUrlOpener = new ExternalUrlOpener();
const nativeNavigationBroker = process.env.CODEX_BOARD_ENABLE_NATIVE_BROKER === "1"
  ? new NativeNavigationBroker({ navigator: codexAppNavigator, logger })
  : null;
const backgroundRefreshes = new Map();
const SOURCE_SERVICES = Object.freeze({
  codex: {
    label: "Codex",
    boardStore,
    snapshotStore,
    threadService,
  },
  chatgpt: {
    label: "ChatGPT",
    boardStore: chatGptBoardStore,
    snapshotStore: chatGptSnapshotStore,
    threadService: chatGptThreadService,
    initialStatus: (thread) => thread.pinned ? "todo" : "done",
    runtimeStatusNote: "ChatGPT 页签只读取本机目录，不读取消息正文。",
    activityStatusNote: "ChatGPT 暂不显示运行中或未读徽标；完成后有新回复会按更新时间移回收件箱。",
  },
  claude: {
    label: "Claude",
    boardStore: claudeBoardStore,
    snapshotStore: claudeSnapshotStore,
    threadService: claudeThreadService,
    initialStatus: () => "done",
    runtimeStatusNote: "Claude 页签只读取 Claude Code 本机会话元数据，不读取消息正文。",
    activityStatusNote: "Claude Code 暂不显示运行中或未读徽标；完成后会话若再次更新，会移回收件箱。",
  },
});

if (nativeNavigationBroker) {
  await nativeNavigationBroker.start().catch((error) => {
    logger.error(`无法启动网页原生导航代理: ${error.message}`);
  });
}

function boardSource(value) {
  const source = String(value ?? "codex");
  if (!BOARD_SOURCE_IDS.has(source)) throw new Error(`无效的对话来源：${source}`);
  return source;
}

function sourceServices(source) {
  const services = SOURCE_SERVICES[source];
  if (!services) throw new Error(`无效的对话来源：${source}`);
  return services;
}

const SOURCE_SCHEMA = {
  type: "string",
  enum: BOARD_SOURCES.map(({ id }) => id),
  description: "对话来源；可选 Codex、ChatGPT 或 Claude，默认 Codex。",
  default: "codex",
};

const SHOW_BOARD_META = {
  ui: {
    resourceUri: UI_URI,
    visibility: ["model", "app"],
  },
  "openai/outputTemplate": UI_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": "正在读取 Codex 对话…",
  "openai/toolInvocation/invoked": "对话看板已打开",
};

const APP_ONLY_META = {
  ui: { visibility: ["app"] },
  "openai/visibility": "private",
  "openai/widgetAccessible": true,
};

const TOOLS = [
  {
    name: "show_board",
    title: "打开对话看板",
    description: "在 Codex 内打开可交互、可全屏的 Codex / ChatGPT / Claude 对话看板。",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "忽略短期缓存并重新读取对话。",
          default: false,
        },
        source: SOURCE_SCHEMA,
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: SHOW_BOARD_META,
  },
  {
    name: "get_fast_snapshot",
    title: "读取看板快速快照",
    description: "为看板 UI 读取本机缓存快照，不启动 Codex App Server。",
    inputSchema: {
      type: "object",
      properties: { source: SOURCE_SCHEMA },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "get_board",
    title: "读取对话看板",
    description: "为看板 UI 读取本机 Codex、ChatGPT 或 Claude 对话和已保存状态。",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        force: { type: "boolean", default: false },
        fresh: {
          type: "boolean",
          description: "绕过短期缓存读取最新对话，但仍按需加载已完成历史。",
          default: false,
        },
        includeDone: {
          type: "boolean",
          description: "是否读取并返回已完成泳道的对话详情。默认按需加载。",
          default: false,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "get_thread_activity",
    title: "读取对话活动状态",
    description: "读取卡片是否仍在运行、是否原生未读，并把有新回复的已完成对话移回收件箱。",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        threadIds: {
          type: "array",
          items: { type: "string", description: "对话或会话 ID。" },
          maxItems: 200,
        },
        metadataThreadIds: {
          type: "array",
          items: { type: "string", description: "需要同步最新标题的当前卡片 ID。" },
          maxItems: 200,
          description: "可选；批量读取当前可见卡片的最新标题，不读取消息正文。",
        },
      },
      required: ["threadIds"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "move_thread",
    title: "移动对话卡片",
    description: "把一个对话移动到指定看板状态并保存到本机。",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        threadId: { type: "string", description: "对话或会话 ID。" },
        status: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,39}$",
          description: "当前来源看板中已有的状态 ID。",
        },
        beforeThreadId: {
          type: ["string", "null"],
          description: "可选；把卡片插入到该卡片之前。",
          default: null,
        },
      },
      required: ["threadId", "status"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "update_board_columns",
    title: "更新看板状态设置",
    description: "设置当前对话来源的状态类型、名称、颜色和泳道顺序。",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        columns: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" },
              label: { type: "string", minLength: 1, maxLength: 24 },
              description: { type: "string", maxLength: 80 },
              color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
            },
            required: ["id", "label", "color"],
            additionalProperties: false,
          },
        },
        migrationTarget: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,39}$",
          description: "被删除状态中的卡片要迁移到的保留状态，默认收件箱。",
          default: "inbox",
        },
      },
      required: ["columns"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "open_thread",
    title: "打开对话",
    description: "在对应桌面应用中打开指定的 Codex、ChatGPT 或 Claude 对话。",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        threadId: { type: "string", description: "对话或会话 ID。" },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: APP_ONLY_META,
  },
];

function compactThread(thread) {
  return {
    id: thread.id,
    title: thread.title,
    project: {
      id: thread.project.id,
      name: thread.project.name,
    },
    runtime: thread.runtime,
    activity: thread.activity ?? {
      state: "idle",
      label: "",
      unread: false,
      startedAt: null,
      completedAt: null,
    },
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    openUrl: thread.openUrl,
    conversationKind: thread.conversationKind ?? "codex",
    pinned: thread.pinned === true,
    boardStatus: thread.boardStatus,
    boardPosition: thread.boardPosition,
    completedToday: thread.completedToday === true,
  };
}

/**
 * 原生侧栏蓝点表示对话有未读回复。这里只扫描 board.json 里的完成 ID，
 * 不加载已完成对话正文，因此完成泳道再大也不会拖慢轮询。
 */
async function reopenUnreadDoneThreads({ boardSnapshot = null } = {}) {
  const currentBoard = boardSnapshot ?? await boardStore.snapshot({ force: true });
  const nativeUnreadIds = await activityTracker.nativeUnreadThreadIds().catch(() => new Set());
  const candidates = currentBoard.columns.done.filter((threadId) => nativeUnreadIds.has(threadId));
  if (candidates.length === 0) {
    return { boardSnapshot: currentBoard, reopenedThreadIds: [], nativeUnreadIds };
  }

  const result = await boardStore.reopenDoneThreads(candidates);
  return {
    boardSnapshot: result.board,
    reopenedThreadIds: result.movedThreadIds,
    nativeUnreadIds,
  };
}

async function buildCodexSnapshot({ force = false, fresh = false, includeDone = false } = {}) {
  const boardSnapshot = await boardStore.snapshot({ force: force || fresh });
  const columnDefinitions = boardSnapshot.columnDefinitions;
  const snapshotNow = Date.now();
  const todayStart = startOfLocalDayMs(snapshotNow);
  const todayBoardDoneIds = boardSnapshot.columns.done.filter((threadId) =>
    isSameLocalDay(boardSnapshot.statusChangedAt?.[threadId], snapshotNow));
  const knownThreadIds = Object.values(boardSnapshot.columns).flat();
  const activeThreadIds = columnDefinitions
    .filter(({ id }) => id !== "done")
    .flatMap(({ id }) => boardSnapshot.columns[id]);
  const threads = includeDone
    ? await threadService.listThreads({ limit: 1_200, force: force || fresh })
    : await threadService.listBoardThreads({
      activeThreadIds,
      previewThreadIds: todayBoardDoneIds,
      doneThreadIds: boardSnapshot.columns.done,
      knownThreadIds,
      recentDoneSince: todayStart,
      force,
      fresh,
    });
  const allArranged = await boardStore.arrangeThreads(threads, { board: boardSnapshot });
  const activities = await activityTracker.observeThreads(allArranged);
  const todayBoardDoneSet = new Set(todayBoardDoneIds);
  const completedToday = (thread) => thread.boardStatus === "done" && (
    todayBoardDoneSet.has(thread.id) ||
    isSameLocalDay(activities[thread.id]?.completedAt ?? thread.updatedAt, snapshotNow)
  );
  const arranged = allArranged
    .filter((thread) => includeDone || thread.boardStatus !== "done" || completedToday(thread))
    .map((thread) => ({ ...thread, completedToday: completedToday(thread) }));
  const titleMetadata = await codexThreadMetadataService.read(arranged.map((thread) => thread.id));
  const projectMap = new Map();

  for (const thread of arranged) {
    const current = projectMap.get(thread.project.id) ?? {
      id: thread.project.id,
      name: thread.project.name,
      count: 0,
    };
    current.count += 1;
    projectMap.set(current.id, current);
  }

  const projects = [...projectMap.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
  );
  const arrangedCounts = Object.fromEntries(columnDefinitions.map(({ id }) => [id, 0]));
  for (const thread of arranged) arrangedCounts[thread.boardStatus] += 1;
  const donePreviewCount = arranged.filter(
    (thread) => thread.boardStatus === "done" && thread.completedToday === true,
  ).length;
  const columnCounts = {
    ...arrangedCounts,
    done: includeDone ? arrangedCounts.done : boardSnapshot.columns.done.length,
  };

  return {
    source: "codex",
    snapshotVersion: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    activitySourceVersion: ACTIVITY_SOURCE_VERSION,
    columns: columnDefinitions,
    projects,
    threads: arranged.map((thread) => compactThread({
      ...thread,
      title: titleMetadata[thread.id]?.title ?? thread.title,
      activity: activities[thread.id],
    })),
    total: Object.values(columnCounts).reduce((sum, count) => sum + count, 0),
    columnCounts,
    doneLoaded: includeDone,
    donePreviewMode: "today",
    donePreviewDate: localDateKey(snapshotNow),
    donePreviewCount,
    runtimeStatusNote: "未加载表示当前独立 App Server 无法确认该对话在 Codex 桌面端的实时运行状态。",
    activityStatusNote: "对话中来自本机任务生命周期；新回复未读直接读取 Codex 原生侧栏蓝点状态。",
  };
}

/**
 * ChatGPT 和 Claude 都没有可复用的 Codex rollout 生命周期。完成卡片是否
 * 收到新内容，统一比较本机目录更新时间与“移到完成”的时间。
 */
async function reopenUpdatedDoneCatalogThreads({ boardStore: selectedBoardStore, boardSnapshot, threads }) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const candidates = boardSnapshot.columns.done.filter((threadId) => {
    const changedAt = Date.parse(boardSnapshot.statusChangedAt?.[threadId] ?? "");
    const updatedAt = Number(byId.get(threadId)?.updatedAt ?? 0);
    return Number.isFinite(changedAt) && updatedAt > changedAt + 1;
  });
  if (candidates.length === 0) {
    return { boardSnapshot, reopenedThreadIds: [] };
  }
  const result = await selectedBoardStore.reopenDoneThreads(candidates);
  return { boardSnapshot: result.board, reopenedThreadIds: result.movedThreadIds };
}

/**
 * 为“本机目录型”对话源构建相同的看板模型。新增来源只需要提供线程服务、
 * 独立状态文件、首次归档策略和说明，不再复制整套看板逻辑。
 */
async function buildCatalogSnapshot({ source, force = false, fresh = false, includeDone = false } = {}) {
  const services = sourceServices(source);
  let boardSnapshot = await services.boardStore.snapshot({ force: force || fresh });
  const catalog = await services.threadService.listThreads({ force: force || fresh });
  const threads = catalog.threads;
  const baseline = await services.boardStore.initializeIfEmpty(threads.map((thread) => ({
    threadId: thread.id,
    status: services.initialStatus(thread),
    changedAt: new Date(thread.updatedAt || Date.now()).toISOString(),
  })));
  boardSnapshot = baseline.board;
  const reopened = await reopenUpdatedDoneCatalogThreads({
    boardStore: services.boardStore,
    boardSnapshot,
    threads,
  });
  boardSnapshot = reopened.boardSnapshot;
  const columnDefinitions = boardSnapshot.columnDefinitions;

  const snapshotNow = Date.now();
  const todayBoardDoneIds = boardSnapshot.columns.done.filter((threadId) =>
    isSameLocalDay(boardSnapshot.statusChangedAt?.[threadId], snapshotNow));
  const todayBoardDoneSet = new Set(todayBoardDoneIds);
  const allArranged = await services.boardStore.arrangeThreads(threads, { board: boardSnapshot });
  const completedToday = (thread) => thread.boardStatus === "done" && (
    todayBoardDoneSet.has(thread.id) || isSameLocalDay(thread.updatedAt, snapshotNow)
  );
  const arranged = allArranged
    .filter((thread) => includeDone || thread.boardStatus !== "done" || completedToday(thread))
    .map((thread) => ({ ...thread, completedToday: completedToday(thread) }));
  const projectMap = new Map();
  for (const thread of arranged) {
    const current = projectMap.get(thread.project.id) ?? {
      id: thread.project.id,
      name: thread.project.name,
      count: 0,
    };
    current.count += 1;
    projectMap.set(current.id, current);
  }
  const projects = [...projectMap.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
  );
  const columnCounts = Object.fromEntries(columnDefinitions.map(({ id }) => [id, 0]));
  for (const thread of allArranged) columnCounts[thread.boardStatus] += 1;
  const donePreviewCount = arranged.filter(
    (thread) => thread.boardStatus === "done" && thread.completedToday === true,
  ).length;

  return {
    source,
    snapshotVersion: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    activitySourceVersion: ACTIVITY_SOURCE_VERSION,
    columns: columnDefinitions,
    projects,
    threads: arranged.map(compactThread),
    total: allArranged.length,
    columnCounts,
    doneLoaded: includeDone,
    donePreviewMode: "today",
    donePreviewDate: localDateKey(snapshotNow),
    donePreviewCount,
    reopenedThreadIds: reopened.reopenedThreadIds,
    sourceDiagnostics: catalog.diagnostics ?? null,
    runtimeStatusNote: services.runtimeStatusNote,
    activityStatusNote: services.activityStatusNote,
  };
}

async function buildSnapshot({ source = "codex", force = false, fresh = false, includeDone = false } = {}) {
  return source === "codex"
    ? buildCodexSnapshot({ force, fresh, includeDone })
    : buildCatalogSnapshot({ source, force, fresh, includeDone });
}

function toFastSnapshot(snapshot) {
  const threads = snapshot.threads.filter(
    (thread) => thread.boardStatus !== "done" || thread.completedToday === true,
  );
  const projectMap = new Map();
  for (const thread of threads) {
    const project = projectMap.get(thread.project.id) ?? {
      id: thread.project.id,
      name: thread.project.name,
      count: 0,
    };
    project.count += 1;
    projectMap.set(project.id, project);
  }
  return {
    ...snapshot,
    projects: [...projectMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
    ),
    threads,
    doneLoaded: false,
    donePreviewMode: "today",
    donePreviewCount: threads.filter((thread) => thread.boardStatus === "done").length,
  };
}

function scheduleBackgroundRefresh(source) {
  if (backgroundRefreshes.has(source)) return;
  const timer = setTimeout(() => {
    backgroundRefreshes.delete(source);
    const { snapshotStore: selectedSnapshotStore } = sourceServices(source);
    buildSnapshot({ source, includeDone: false })
      .then((snapshot) => selectedSnapshotStore.save(toFastSnapshot(snapshot)))
      .catch((error) => logger.error(`后台刷新${source}看板快照失败: ${error.message}`));
  }, 750);
  backgroundRefreshes.set(source, timer);
}

function textResult(text, structuredContent, meta = undefined) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(meta ? { _meta: meta } : {}),
  };
}

async function callTool(name, args = {}, context = {}) {
  if (name === "show_board") {
    const source = boardSource(args.source);
    const { snapshotStore: selectedSnapshotStore } = sourceServices(source);
    const force = args.force === true;
    let snapshot = force ? null : await selectedSnapshotStore.load();
    if (!snapshot) {
      snapshot = toFastSnapshot(await buildSnapshot({ source, force, includeDone: false }));
      await selectedSnapshotStore.save(snapshot);
    } else {
      scheduleBackgroundRefresh(source);
    }
    return textResult(
      `${sourceServices(source).label} 对话看板已就绪：${snapshot.total} 个对话。`,
      {
        ...snapshot,
        ready: true,
      },
      { ui: { resourceUri: UI_URI } },
    );
  }

  if (name === "get_board") {
    const source = boardSource(args.source);
    const { snapshotStore: selectedSnapshotStore } = sourceServices(source);
    const snapshot = await buildSnapshot({
      source,
      force: args.force === true,
      fresh: args.fresh === true,
      includeDone: args.includeDone === true,
    });
    await selectedSnapshotStore.save(toFastSnapshot(snapshot));
    return textResult(
      `已读取 ${snapshot.threads.length} 个对话。`,
      snapshot,
    );
  }

  if (name === "get_fast_snapshot") {
    const source = boardSource(args.source);
    const {
      boardStore: selectedBoardStore,
      snapshotStore: selectedSnapshotStore,
    } = sourceServices(source);
    const snapshot = await selectedSnapshotStore.load();
    const boardSnapshot = snapshot ? null : await selectedBoardStore.snapshot({ force: true });
    const columns = boardSnapshot?.columnDefinitions ?? BOARD_COLUMNS;
    const result = snapshot ?? {
      ready: false,
      source,
      snapshotVersion: SNAPSHOT_VERSION,
      generatedAt: new Date().toISOString(),
      activitySourceVersion: ACTIVITY_SOURCE_VERSION,
      columns,
      projects: [],
      threads: [],
      total: 0,
      columnCounts: Object.fromEntries(columns.map(({ id }) => [id, 0])),
      doneLoaded: false,
      donePreviewMode: "today",
      donePreviewDate: localDateKey(),
      donePreviewCount: 0,
    };
    return textResult("已读取快速快照。", result);
  }

  if (name === "get_thread_activity") {
    const source = boardSource(args.source);
    const threadIds = Array.isArray(args.threadIds) ? [...new Set(args.threadIds.map(String))] : [];
    const metadataThreadIds = Array.isArray(args.metadataThreadIds)
      ? [...new Set(args.metadataThreadIds.map(String))]
      : threadIds;
    if (threadIds.length > 200) throw new Error("一次最多读取 200 个对话状态");
    if (metadataThreadIds.length > 200) throw new Error("一次最多同步 200 个对话标题");
    if (threadIds.some((threadId) => !isConversationId(source, threadId))) {
      throw new Error("threadIds 包含无效的对话或会话 ID");
    }
    if (metadataThreadIds.some((threadId) => !isConversationId(source, threadId))) {
      throw new Error("metadataThreadIds 包含无效的对话或会话 ID");
    }
    if (source !== "codex") {
      const services = sourceServices(source);
      const boardSnapshot = await services.boardStore.snapshot({ force: true });
      const { threads } = await services.threadService.listThreads({ force: true });
      const reopened = await reopenUpdatedDoneCatalogThreads({
        boardStore: services.boardStore,
        boardSnapshot,
        threads,
      });
      const activities = Object.fromEntries(threadIds.map((threadId) => [threadId, {
        state: "idle",
        label: "",
        unread: false,
        startedAt: null,
        completedAt: null,
      }]));
      const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
      const threadMetadata = Object.fromEntries(metadataThreadIds.flatMap((threadId) => {
        const title = threadsById.get(threadId)?.title;
        return typeof title === "string" && title ? [[threadId, { title }]] : [];
      }));
      return textResult(`已读取 ${services.label} 对话活动状态。`, {
        source,
        generatedAt: new Date().toISOString(),
        activitySourceVersion: ACTIVITY_SOURCE_VERSION,
        activities,
        threadMetadata,
        reopenedThreadIds: reopened.reopenedThreadIds,
      });
    }
    const [reopened, threadMetadata] = await Promise.all([
      reopenUnreadDoneThreads(),
      codexThreadMetadataService.read(metadataThreadIds),
    ]);
    const activities = await activityTracker.refresh(threadIds, {
      nativeUnreadIds: reopened.nativeUnreadIds,
    });
    return textResult("已读取对话活动状态。", {
      source,
      generatedAt: new Date().toISOString(),
      activitySourceVersion: ACTIVITY_SOURCE_VERSION,
      activities,
      threadMetadata,
      reopenedThreadIds: reopened.reopenedThreadIds,
    });
  }

  if (name === "move_thread") {
    const source = boardSource(args.source);
    const { boardStore: selectedBoardStore } = sourceServices(source);
    const threadId = String(args.threadId ?? "");
    const status = String(args.status ?? "");
    const beforeThreadId = args.beforeThreadId == null ? null : String(args.beforeThreadId);

    if (!isConversationId(source, threadId)) throw new Error("threadId 不是有效的对话或会话 ID");
    const boardSnapshot = await selectedBoardStore.snapshot({ force: true });
    const targetColumn = boardSnapshot.columnDefinitions.find((column) => column.id === status);
    if (!targetColumn) throw new Error(`无效的看板状态：${status}`);
    if (beforeThreadId && !isConversationId(source, beforeThreadId)) {
      throw new Error("beforeThreadId 不是有效的对话或会话 ID");
    }
    if (beforeThreadId === threadId) throw new Error("beforeThreadId 不能与 threadId 相同");

    await selectedBoardStore.moveThread(threadId, status, beforeThreadId);
    const result = { ok: true, source, threadId, status };
    return textResult(`已移动到${targetColumn.label}。`, result);
  }

  if (name === "update_board_columns") {
    const source = boardSource(args.source);
    const {
      boardStore: selectedBoardStore,
      snapshotStore: selectedSnapshotStore,
    } = sourceServices(source);
    const update = await selectedBoardStore.updateColumns(args.columns, {
      migrationTarget: String(args.migrationTarget ?? "inbox"),
    });
    const snapshot = await buildSnapshot({ source, force: true, includeDone: false });
    await selectedSnapshotStore.save(toFastSnapshot(snapshot));
    const migratedCount = update.migratedThreadIds.length;
    return textResult(
      migratedCount > 0
        ? `状态设置已保存，${migratedCount} 个对话已迁移。`
        : "状态设置已保存。",
      {
        ...snapshot,
        settingsUpdate: {
          removedStatusIds: update.removedStatusIds,
          migratedThreadIds: update.migratedThreadIds,
          migrationTarget: update.migrationTarget,
        },
      },
    );
  }

  if (name === "open_thread") {
    const source = boardSource(args.source);
    const threadId = String(args.threadId ?? "");
    if (!isConversationId(source, threadId)) throw new Error("threadId 不是有效的对话或会话 ID");
    const url = source === "codex"
      ? `codex://threads/${threadId}`
      : source === "claude"
        ? claudeOpenUrl(threadId)
        : null;
    const navigation = source === "chatgpt"
      ? await codexAppNavigator.navigateToThread(threadId, context)
      : await externalUrlOpener.open(url);
    const activity = source === "codex"
      ? await activityTracker.markSeen(threadId).catch(() => null)
      : null;
    return textResult(
      `已在 ${source === "claude" ? "Claude" : "Codex"} 中打开对话。`,
      { ok: true, source, threadId, url, activity, ...navigation },
    );
  }

  throw new Error(`未知工具：${name}`);
}

async function readUiResource() {
  const [source, snapshot] = await Promise.all([
    readFile(UI_PATH, "utf8"),
    snapshotStore.load(),
  ]);
  const bootstrap = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const html = source.replace("__CODEX_BOARD_BOOTSTRAP__", bootstrap);
  return {
    contents: [
      {
        uri: UI_URI,
        name: "Codex 对话看板",
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
          "openai/widgetPrefersBorder": false,
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [],
          },
        },
      },
    ],
  };
}

async function handleRequest(message) {
  const { method, params = {} } = message;

  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion ?? "2025-03-26",
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: "codex-conversation-board",
        title: "Codex 对话看板",
        version: SERVER_VERSION,
      },
      instructions: "Use show_board to open the interactive local Codex conversation board.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    return callTool(params.name, params.arguments ?? {}, {
      metadata: params._meta ?? {},
      requestId: String(message.id),
    });
  }
  if (method === "resources/list") {
    return {
      resources: [
        {
          uri: UI_URI,
          name: "Codex 对话看板",
          title: "Codex 对话看板",
          description: "管理本机 Codex 对话的交互看板。",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    };
  }
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "resources/read") {
    if (params.uri !== UI_URI) throw new Error(`未知资源：${params.uri}`);
    return readUiResource();
  }
  if (method === "prompts/list") return { prompts: [] };
  if (method === "logging/setLevel") return {};
  throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  if (message.id === undefined) return;
  try {
    const result = await handleRequest(message);
    writeMessage({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    const isMethodMissing = error?.code === -32601;
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: isMethodMissing ? -32601 : -32000,
        message: error?.message ?? String(error),
      },
    });
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await nativeNavigationBroker?.close().catch(() => {});
  await codexAppNavigator.close().catch(() => {});
  await appServer.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
