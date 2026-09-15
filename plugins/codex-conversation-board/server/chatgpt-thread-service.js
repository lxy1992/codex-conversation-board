import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");

export const DEFAULT_CHATGPT_CATALOG_PATH = resolve(CODEX_HOME, "sqlite/codex-dev.db");
export const DEFAULT_CHATGPT_GLOBAL_STATE_PATH = resolve(CODEX_HOME, ".codex-global-state.json");

const PROJECTLESS_ID = "chatgpt-projectless";
const PROJECTLESS_NAME = "普通 Chat";
const MAX_CHATGPT_THREADS = 10_000;

let sqliteModulePromise = null;

function sqliteModule() {
  sqliteModulePromise ??= import("node:sqlite");
  return sqliteModulePromise;
}

function cleanText(value, fallback) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!result) return fallback;
  return result.length > 180 ? `${result.slice(0, 177)}…` : result;
}

function timestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric < 1e12 ? numeric * 1_000 : numeric;
}

function readChatGptSidebarState(root) {
  return root?.["electron-persisted-atom-state"]?.["chatgpt-sidebar-state-v1"] ?? {};
}

function chatGptMetadata(root) {
  const projectNames = new Map();
  const pinnedConversationIds = new Set();

  for (const account of Object.values(readChatGptSidebarState(root))) {
    if (!account || typeof account !== "object") continue;
    for (const project of account.projects ?? []) {
      if (typeof project?.id === "string" && typeof project?.name === "string") {
        projectNames.set(project.id, cleanText(project.name, "ChatGPT 项目"));
      }
    }
    for (const entry of account.pinnedProjects ?? []) {
      const project = entry?.project;
      if (typeof project?.id === "string" && typeof project?.name === "string") {
        projectNames.set(project.id, cleanText(project.name, "ChatGPT 项目"));
      }
    }
    for (const entry of account.pinnedConversations ?? []) {
      if (typeof entry?.conversation?.id === "string") {
        pinnedConversationIds.add(entry.conversation.id);
      }
    }
  }

  return { projectNames, pinnedConversationIds };
}

function normalizeChatGptThread(row, metadata) {
  const projectId = typeof row.project_id === "string" && row.project_id
    ? row.project_id
    : PROJECTLESS_ID;
  return {
    id: row.thread_id,
    title: cleanText(row.display_title, "未命名 Chat"),
    preview: "",
    cwd: null,
    project: {
      id: projectId,
      name: metadata.projectNames.get(projectId) ?? (
        projectId === PROJECTLESS_ID ? PROJECTLESS_NAME : "ChatGPT 项目"
      ),
      rootPaths: [],
    },
    runtime: { type: "idle", state: "idle", label: "", exact: false },
    activity: {
      state: "idle",
      label: "",
      unread: false,
      startedAt: null,
      completedAt: null,
    },
    updatedAt: timestampMs(row.source_recency_at || row.source_updated_at),
    createdAt: timestampMs(row.source_created_at),
    branch: null,
    repository: null,
    source: "chatgpt",
    conversationKind: "chatgpt",
    rolloutPath: null,
    pinned: metadata.pinnedConversationIds.has(row.thread_id),
    // 私有 ChatGPT 对话没有可用的 Codex 深链；点击时由 MCP 工具调用原生导航。
    openUrl: null,
  };
}

/**
 * 读取 Codex 桌面端已经同步到本机的 ChatGPT 对话目录。
 * 这里只读取标题、项目和更新时间，不读取消息正文，也不会向 ChatGPT 发网络请求。
 */
export class ChatGptThreadService {
  constructor({
    catalogPath = process.env.CODEX_CHATGPT_CATALOG_PATH || DEFAULT_CHATGPT_CATALOG_PATH,
    globalStatePath = process.env.CODEX_GLOBAL_STATE_PATH || DEFAULT_CHATGPT_GLOBAL_STATE_PATH,
    cacheTtlMs = 5_000,
  } = {}) {
    this.catalogPath = catalogPath;
    this.globalStatePath = globalStatePath;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.inFlight = null;
  }

  invalidate() {
    this.cache = null;
  }

  async listThreads({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.createdAt < this.cacheTtlMs) {
      return structuredClone(this.cache.value);
    }
    if (this.inFlight) return structuredClone(await this.inFlight);

    this.inFlight = this.#readCatalog();
    try {
      const value = await this.inFlight;
      this.cache = { createdAt: Date.now(), value };
      return structuredClone(value);
    } finally {
      this.inFlight = null;
    }
  }

  async #readCatalog() {
    await access(this.catalogPath);
    const [{ DatabaseSync }, globalState] = await Promise.all([
      sqliteModule(),
      readFile(this.globalStatePath, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => ({})),
    ]);
    const metadata = chatGptMetadata(globalState);
    const database = new DatabaseSync(this.catalogPath, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT
          thread_id,
          display_title,
          source_created_at,
          source_updated_at,
          source_recency_at,
          project_id
        FROM local_thread_catalog
        WHERE source_kind = 'chatgpt' AND missing_candidate = 0
        ORDER BY source_recency_at DESC, source_created_at DESC, thread_id
        LIMIT ?
      `).all(MAX_CHATGPT_THREADS);

      // 同一对话理论上只属于一个账户；若旧账户目录残留，保留最近更新的一条。
      const seen = new Set();
      const threads = [];
      for (const row of rows) {
        if (typeof row.thread_id !== "string" || seen.has(row.thread_id)) continue;
        seen.add(row.thread_id);
        threads.push(normalizeChatGptThread(row, metadata));
      }
      return { threads, total: threads.length };
    } finally {
      database.close();
    }
  }
}

export const chatGptThreadServiceInternals = {
  chatGptMetadata,
  normalizeChatGptThread,
  readChatGptSidebarState,
};
