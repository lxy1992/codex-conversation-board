import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staleWidgetMode = process.env.CODEX_BOARD_STALE_WIDGET === "1";
const legacyToolMode = process.env.CODEX_BOARD_LEGACY_TOOL === "1";
const todayDoneMode = process.env.CODEX_BOARD_TODAY_DONE === "1";
const outputDirectory = staleWidgetMode
  ? "/private/tmp/codex-board-stale-widget-harness"
  : todayDoneMode
    ? "/private/tmp/codex-board-today-done-harness"
    : "/private/tmp/codex-board-ui-harness";
const columns = [
  ["inbox", "收件箱", "刚出现、尚未分类"],
  ["todo", "待处理", "已经明确，等待开始"],
  ["doing", "进行中", "当前正在推进"],
  ["blocked", "阻塞", "等待输入、审批或外部条件"],
  ["review", "待验收", "工作完成，等待确认"],
  ["done", "完成", "已经结束"],
].map(([id, label, description]) => ({ id, label, description }));
const projects = [
  { id: "demo-api", name: "Demo API", count: 6 },
  { id: "demo-app", name: "Demo App", count: 6 },
  { id: "developer-tools", name: "Developer Tools", count: 6 },
];
const titles = [
  "整理本周迭代计划",
  "修复登录页表单校验",
  "设计对话看板插件",
  "核验测试环境结果",
  "实现文件导入确认",
  "补充架构设计笔记",
  "排查服务告警",
  "整理演示数据",
  "更新项目 onboarding 文档",
  "验证跨设备同步",
  "Review PR 并记录结论",
  "准备桌面端测试版本",
  "清理缓存前做容量盘点",
  "核验远端主分支",
  "修复菜单栏窗口状态",
  "整理今日开发记录",
  "检查配置更新结果",
  "完成 UI 回归测试",
];
const threads = titles.map((title, index) => {
  const project = projects[index % projects.length];
  const column = columns[index % columns.length];
  return {
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    title,
    project: { id: project.id, name: project.name },
    runtime: index === 8
      ? { state: "approval", label: "等待审批" }
      : index === 11
        ? { state: "active", label: "运行中" }
        : { state: "unknown", label: "未加载" },
    updatedAt: Date.now() - index * 32 * 60 * 1000,
    branch: index % 3 === 0 ? `feature/mock-${index + 1}` : null,
    openUrl: `codex://threads/mock-${index + 1}`,
    activity: index === 0
      ? { state: "active", label: "对话中", unread: false, startedAt: new Date().toISOString(), completedAt: null }
      : index === 1
        ? { state: "unread", label: "新回复未读", unread: true, startedAt: null, completedAt: new Date().toISOString() }
        : { state: "idle", label: "", unread: false, startedAt: null, completedAt: null },
    boardStatus: column.id,
    boardPosition: Math.floor(index / columns.length),
  };
});
const firstDoneId = threads.find((thread) => thread.boardStatus === "done")?.id;
const allFixtureThreads = todayDoneMode
  ? threads.map((thread) => thread.boardStatus === "done" && thread.id !== firstDoneId
    ? { ...thread, updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1_000 }
    : thread)
  : threads;
const snapshotThreads = todayDoneMode
  ? allFixtureThreads.filter((thread) => thread.boardStatus !== "done" || thread.id === firstDoneId)
  : allFixtureThreads;

const snapshot = {
  source: "codex",
  snapshotVersion: 2,
  generatedAt: new Date().toISOString(),
  activitySourceVersion: 2,
  columns,
  projects,
  threads: snapshotThreads,
  total: allFixtureThreads.length,
  columnCounts: Object.fromEntries(columns.map((column) => [
    column.id,
    allFixtureThreads.filter((thread) => thread.boardStatus === column.id).length,
  ])),
  doneLoaded: !todayDoneMode,
  donePreviewMode: "today",
  donePreviewDate: (() => {
    const date = new Date();
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
      .join("-");
  })(),
  donePreviewCount: todayDoneMode ? 1 : 3,
};
const chatGptThreads = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "ChatGPT 独立页签验收",
    project: { id: "g-p-personal", name: "个人" },
    runtime: { state: "idle", label: "" },
    activity: { state: "idle", label: "", unread: false, startedAt: null, completedAt: null },
    updatedAt: Date.now(),
    branch: null,
    openUrl: null,
    conversationKind: "chatgpt",
    boardStatus: "inbox",
    boardPosition: 0,
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Chat 状态流转测试",
    project: { id: "chatgpt-projectless", name: "普通 Chat" },
    runtime: { state: "idle", label: "" },
    activity: { state: "idle", label: "", unread: false, startedAt: null, completedAt: null },
    updatedAt: Date.now() - 60_000,
    branch: null,
    openUrl: null,
    conversationKind: "chatgpt",
    boardStatus: "doing",
    boardPosition: 0,
  },
];
const chatGptSnapshot = {
  source: "chatgpt",
  snapshotVersion: 2,
  generatedAt: new Date().toISOString(),
  activitySourceVersion: 2,
  columns,
  projects: [
    { id: "g-p-personal", name: "个人", count: 1 },
    { id: "chatgpt-projectless", name: "普通 Chat", count: 1 },
  ],
  threads: chatGptThreads,
  total: chatGptThreads.length,
  columnCounts: Object.fromEntries(columns.map((column) => [
    column.id,
    chatGptThreads.filter((thread) => thread.boardStatus === column.id).length,
  ])),
  doneLoaded: false,
  donePreviewMode: "today",
  donePreviewDate: snapshot.donePreviewDate,
  donePreviewCount: 0,
};
const claudeThreads = [
  {
    id: "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Claude 独立页签验收",
    project: { id: "claude:/work/demo-api", name: "demo-api" },
    runtime: { state: "idle", label: "" },
    activity: { state: "idle", label: "", unread: false, startedAt: null, completedAt: null },
    updatedAt: Date.now(),
    branch: "feat/claude-board",
    openUrl: "claude://code/continue?session=local_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    conversationKind: "claude",
    boardStatus: "inbox",
    boardPosition: 0,
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    title: "Claude CLI 状态流转测试",
    project: { id: "claude:/work/demo-app", name: "demo-app" },
    runtime: { state: "idle", label: "" },
    activity: { state: "idle", label: "", unread: false, startedAt: null, completedAt: null },
    updatedAt: Date.now() - 60_000,
    branch: null,
    openUrl: "claude://resume?session=dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    conversationKind: "claude",
    boardStatus: "doing",
    boardPosition: 0,
  },
];
const claudeSnapshot = {
  source: "claude",
  snapshotVersion: 2,
  generatedAt: new Date().toISOString(),
  activitySourceVersion: 2,
  columns,
  projects: [
    { id: "claude:/work/demo-api", name: "demo-api", count: 1 },
    { id: "claude:/work/demo-app", name: "demo-app", count: 1 },
  ],
  threads: claudeThreads,
  total: claudeThreads.length,
  columnCounts: Object.fromEntries(columns.map((column) => [
    column.id,
    claudeThreads.filter((thread) => thread.boardStatus === column.id).length,
  ])),
  doneLoaded: false,
  donePreviewMode: "today",
  donePreviewDate: snapshot.donePreviewDate,
  donePreviewCount: 0,
  sourceDiagnostics: {
    desktop: { available: true, loaded: 1, path: "/fixture/claude-desktop", error: null },
    cli: { available: true, loaded: 1, path: "/fixture/claude-cli", error: null },
  },
};

const staleWidgetScript = staleWidgetMode
  ? `window.__CODEX_BOARD_LEGACY_SNAPSHOT__ = {
  ...structuredClone(window.__CODEX_BOARD_SNAPSHOT__),
  activitySourceVersion: undefined,
  threads: window.__CODEX_BOARD_SNAPSHOT__.threads.map(({ activity, ...thread }) => thread),
};
window.openai = {
  widgetState: { boardSnapshot: window.__CODEX_BOARD_LEGACY_SNAPSHOT__ },
};`
  : "";

const mockScript = `<script>
window.__CODEX_BOARD_CALLS__ = [];
window.__CODEX_BOARD_ACTIVITY_OVERRIDES__ = {};
window.__CODEX_BOARD_TITLE_OVERRIDES__ = {};
window.__CODEX_BOARD_REOPENED_IDS__ = [];
window.__CODEX_BOARD_THREADS__ = ${JSON.stringify(snapshotThreads)};
window.__CODEX_BOARD_SNAPSHOT__ = ${JSON.stringify(snapshot)};
window.__CODEX_BOARD_CHATGPT_THREADS__ = ${JSON.stringify(chatGptThreads)};
window.__CODEX_BOARD_CHATGPT_SNAPSHOT__ = ${JSON.stringify(chatGptSnapshot)};
window.__CODEX_BOARD_CLAUDE_THREADS__ = ${JSON.stringify(claudeThreads)};
window.__CODEX_BOARD_CLAUDE_SNAPSHOT__ = ${JSON.stringify(claudeSnapshot)};
${staleWidgetScript}
window.__CODEX_BOARD_MOCK__ = async (name, args) => {
  window.__CODEX_BOARD_CALLS__.push({ name, args });
  document.body.dataset.lastTool = name;
  if (name === "get_fast_snapshot" || name === "get_board") {
    const sourceSnapshot = args.source === "chatgpt"
      ? window.__CODEX_BOARD_CHATGPT_SNAPSHOT__
      : args.source === "claude"
        ? window.__CODEX_BOARD_CLAUDE_SNAPSHOT__
        : ${legacyToolMode
          ? "window.__CODEX_BOARD_LEGACY_SNAPSHOT__"
          : "window.__CODEX_BOARD_SNAPSHOT__"};
    return {
      structuredContent: name === "get_board" && args.includeDone === true
        ? { ...structuredClone(sourceSnapshot), doneLoaded: true }
        : sourceSnapshot,
    };
  }
  if (name === "update_board_columns") {
    const sourceSnapshot = args.source === "chatgpt"
      ? window.__CODEX_BOARD_CHATGPT_SNAPSHOT__
      : args.source === "claude"
        ? window.__CODEX_BOARD_CLAUDE_SNAPSHOT__
        : window.__CODEX_BOARD_SNAPSHOT__;
    const nextIds = new Set(args.columns.map((column) => column.id));
    const migratedThreadIds = [];
    for (const thread of sourceSnapshot.threads) {
      if (nextIds.has(thread.boardStatus)) continue;
      migratedThreadIds.push(thread.id);
      thread.boardStatus = args.migrationTarget || "inbox";
    }
    for (const column of args.columns) {
      sourceSnapshot.threads
        .filter((thread) => thread.boardStatus === column.id)
        .forEach((thread, index) => { thread.boardPosition = index; });
    }
    sourceSnapshot.columns = structuredClone(args.columns);
    sourceSnapshot.columnCounts = Object.fromEntries(args.columns.map((column) => [
      column.id,
      sourceSnapshot.threads.filter((thread) => thread.boardStatus === column.id).length,
    ]));
    sourceSnapshot.generatedAt = new Date().toISOString();
    return {
      structuredContent: {
        ...structuredClone(sourceSnapshot),
        settingsUpdate: {
          migratedThreadIds,
          migrationTarget: args.migrationTarget || "inbox",
        },
      },
    };
  }
  if (name === "move_thread") return { structuredContent: { ok: true, ...args } };
  if (name === "get_thread_activity") {
    ${staleWidgetMode ? "await new Promise((resolve) => setTimeout(resolve, 2_000));" : ""}
    return {
      structuredContent: {
        generatedAt: new Date().toISOString(),
        activitySourceVersion: 2,
        activities: Object.fromEntries(
          (args.source === "chatgpt"
            ? window.__CODEX_BOARD_CHATGPT_THREADS__
            : args.source === "claude"
              ? window.__CODEX_BOARD_CLAUDE_THREADS__
              : window.__CODEX_BOARD_THREADS__)
            .filter((thread) => args.threadIds.includes(thread.id)).map((thread) => [
            thread.id,
            window.__CODEX_BOARD_ACTIVITY_OVERRIDES__[thread.id] || thread.activity,
          ]),
        ),
        threadMetadata: Object.fromEntries(
          (args.metadataThreadIds || args.threadIds).map((threadId) => {
            const sourceThreads = args.source === "chatgpt"
              ? window.__CODEX_BOARD_CHATGPT_THREADS__
              : args.source === "claude"
                ? window.__CODEX_BOARD_CLAUDE_THREADS__
                : window.__CODEX_BOARD_THREADS__;
            const thread = sourceThreads.find((item) => item.id === threadId);
            return [threadId, {
              title: window.__CODEX_BOARD_TITLE_OVERRIDES__[threadId] || thread?.title || "未命名对话",
            }];
          }),
        ),
        reopenedThreadIds: window.__CODEX_BOARD_REOPENED_IDS__.splice(0),
      },
    };
  }
  if (name === "open_thread") {
    document.body.dataset.openedThread = args.source === "chatgpt"
      ? "codex-app://chat/" + args.threadId
      : args.source === "claude"
        ? (args.threadId.startsWith("local_")
          ? "claude://code/continue?session=" + args.threadId
          : "claude://resume?session=" + args.threadId)
        : "codex://threads/" + args.threadId;
    return { structuredContent: { ok: true, ...args, activity: { state: "idle", label: "", unread: false } } };
  }
  throw new Error("Unknown mock tool: " + name);
};
window.__CODEX_BOARD_HOST__ = {
  requestDisplayMode: async (request) => {
    window.__DISPLAY_MODE__ = request.mode;
    document.body.dataset.displayMode = request.mode;
  },
  openExternal: async ({ href }) => {
    window.__OPENED_THREAD__ = href;
    // Reproduce the Codex in-app browser behavior: the host accepts the
    // custom codex:// URL but does not actually navigate the main app.
    document.body.dataset.openExternalAttempted = href;
  },
};
</script>`;

const source = await readFile(resolve(root, "ui/board.html"), "utf8");
const dragHarness = `<button id="simulateDrag" type="button" style="position:fixed;left:2px;bottom:2px;z-index:99;opacity:.01">simulate drag</button>
<script>
document.querySelector("#simulateDrag").addEventListener("click", () => {
  const sourceCard = document.querySelector('.cards[data-status="inbox"] .card');
  const target = document.querySelector('.cards[data-status="doing"]');
  const transfer = new DataTransfer();
  sourceCard.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.bottom - 4 }));
  sourceCard.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
});
</script>`;
const html = source
  .replace("    <script>\n      (() => {", `${mockScript}\n    <script>\n      (() => {`)
  .replace(
    "        setInterval(refreshActivities, 5_000);",
    "        window.__CODEX_BOARD_REFRESH_ACTIVITIES__ = refreshActivities;\n        window.__CODEX_BOARD_APPLY_DATA__ = applyBoardData;\n        setInterval(refreshActivities, 5_000);",
  )
  .replace("  </body>", `    ${dragHarness}\n  </body>`);
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "index.html"), html);
process.stdout.write(`${resolve(outputDirectory, "index.html")}\n`);
