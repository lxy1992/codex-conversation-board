import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  CLAUDE_DESKTOP_SESSION_ID_PATTERN,
  CODEX_THREAD_ID_PATTERN,
} from "./constants.js";

const MAX_SESSION_FILES = 10_000;
const MAX_METADATA_BYTES = 512 * 1024;

function defaultDesktopRoot({ platform = process.platform, home = homedir(), appData = process.env.APPDATA } = {}) {
  if (platform === "darwin") {
    return resolve(home, "Library/Application Support/Claude/claude-code-sessions");
  }
  if (platform === "win32" && appData) {
    return resolve(appData, "Claude/claude-code-sessions");
  }
  return resolve(home, ".config/Claude/claude-code-sessions");
}

function cleanText(value, fallback) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!result) return fallback;
  return result.length > 180 ? `${result.slice(0, 177)}…` : result;
}

function timestampMs(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric < 1e12 ? numeric * 1_000 : numeric;
}

function projectForPath(value) {
  const path = typeof value === "string" && value.trim() ? resolve(value) : null;
  if (!path) {
    return { id: "claude-projectless", name: "无项目", rootPaths: [] };
  }
  return {
    id: `claude:${path}`,
    name: cleanText(basename(path), "Claude 项目"),
    rootPaths: [path],
  };
}

function idleActivity() {
  return {
    state: "idle",
    label: "",
    unread: false,
    startedAt: null,
    completedAt: null,
  };
}

export function claudeOpenUrl(sessionId) {
  const id = String(sessionId ?? "");
  if (CLAUDE_DESKTOP_SESSION_ID_PATTERN.test(id)) {
    return `claude://code/continue?session=${encodeURIComponent(id)}`;
  }
  if (CODEX_THREAD_ID_PATTERN.test(id)) {
    return `claude://resume?session=${encodeURIComponent(id)}`;
  }
  throw new Error("无效的 Claude 会话 ID");
}

function normalizeDesktopSession(value, fileModifiedAt = 0) {
  if (!value || typeof value !== "object" || value.isArchived === true) return null;
  if (!CLAUDE_DESKTOP_SESSION_ID_PATTERN.test(value.sessionId ?? "")) return null;
  const cwd = typeof value.cwd === "string" && value.cwd.trim()
    ? value.cwd
    : value.originCwd;
  const updatedAt = timestampMs(value.lastActivityAt) || fileModifiedAt;
  return {
    id: value.sessionId,
    title: cleanText(value.title, "未命名 Claude 对话"),
    preview: "",
    cwd: typeof cwd === "string" ? cwd : null,
    project: projectForPath(cwd),
    runtime: { type: "idle", state: "idle", label: "", exact: false },
    activity: idleActivity(),
    updatedAt,
    createdAt: timestampMs(value.createdAt),
    branch: typeof value.gitBranch === "string" ? value.gitBranch : null,
    repository: null,
    source: "claude",
    conversationKind: "claude",
    rolloutPath: null,
    pinned: false,
    openUrl: claudeOpenUrl(value.sessionId),
    claudeSessionKind: "desktop",
    cliSessionId: CODEX_THREAD_ID_PATTERN.test(value.cliSessionId ?? "") ? value.cliSessionId : null,
  };
}

function normalizeCliSession(value, projectPath) {
  if (!value || typeof value !== "object" || value.isSidechain === true) return null;
  if (!CODEX_THREAD_ID_PATTERN.test(value.sessionId ?? "")) return null;
  const cwd = typeof value.projectPath === "string" && value.projectPath.trim()
    ? value.projectPath
    : projectPath;
  return {
    id: value.sessionId,
    title: cleanText(value.summary, cleanText(value.firstPrompt, "未命名 Claude 对话")),
    preview: "",
    cwd: typeof cwd === "string" ? cwd : null,
    project: projectForPath(cwd),
    runtime: { type: "idle", state: "idle", label: "", exact: false },
    activity: idleActivity(),
    updatedAt: timestampMs(value.modified) || timestampMs(value.fileMtime),
    createdAt: timestampMs(value.created),
    branch: typeof value.gitBranch === "string" && value.gitBranch.trim() ? value.gitBranch : null,
    repository: null,
    source: "claude",
    conversationKind: "claude",
    rolloutPath: null,
    pinned: false,
    openUrl: claudeOpenUrl(value.sessionId),
    claudeSessionKind: "cli",
    cliSessionId: value.sessionId,
  };
}

async function collectJsonFiles(root, limit = MAX_SESSION_FILES) {
  const files = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
      // Symlinks are intentionally ignored: a local metadata directory must not
      // make the plugin traverse arbitrary paths on somebody else's machine.
    }
  }
  return files;
}

async function readSmallJson(path) {
  const metadata = await stat(path);
  if (metadata.size > MAX_METADATA_BYTES) throw new Error("metadata file is too large");
  return { value: JSON.parse(await readFile(path, "utf8")), modifiedAt: metadata.mtimeMs };
}

async function readDesktopSessions(root) {
  try {
    if (!(await stat(root)).isDirectory()) return { available: false, threads: [] };
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, threads: [] };
    throw error;
  }
  const paths = await collectJsonFiles(root);
  const settled = await Promise.allSettled(paths.map(async (path) => {
    const { value, modifiedAt } = await readSmallJson(path);
    return normalizeDesktopSession(value, modifiedAt);
  }));
  return {
    available: true,
    threads: settled.flatMap((item) => item.status === "fulfilled" && item.value ? [item.value] : []),
  };
}

async function readCliSessions(root) {
  let projectDirectories;
  try {
    projectDirectories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, threads: [] };
    throw error;
  }
  const indexPaths = projectDirectories
    .filter((entry) => entry.isDirectory())
    .slice(0, MAX_SESSION_FILES)
    .map((entry) => resolve(root, entry.name, "sessions-index.json"));
  const settled = await Promise.allSettled(indexPaths.map(async (path) => {
    const { value } = await readSmallJson(path);
    const projectPath = typeof value?.originalPath === "string" ? value.originalPath : null;
    return (Array.isArray(value?.entries) ? value.entries : [])
      .map((entry) => normalizeCliSession(entry, projectPath))
      .filter(Boolean);
  }));
  return {
    available: true,
    threads: settled.flatMap((item) => item.status === "fulfilled" ? item.value : []),
  };
}

/**
 * 读取 Claude Code 已保存在本机的会话元数据。
 *
 * Claude Desktop 元数据优先，CLI sessions-index.json 作为补充；两者若指向
 * 同一个 cliSessionId，只保留能直接继续桌面会话的那张卡片。不会读取 JSONL
 * 对话正文，也不会访问 claude.ai。
 */
export class ClaudeThreadService {
  constructor({
    desktopRoot = process.env.CLAUDE_DESKTOP_SESSIONS_PATH || defaultDesktopRoot(),
    cliProjectsRoot = process.env.CLAUDE_CLI_PROJECTS_PATH || resolve(
      process.env.CLAUDE_HOME || resolve(homedir(), ".claude"),
      "projects",
    ),
    cacheTtlMs = 5_000,
  } = {}) {
    this.desktopRoot = desktopRoot;
    this.cliProjectsRoot = cliProjectsRoot;
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
    const [desktopResult, cliResult] = await Promise.allSettled([
      readDesktopSessions(this.desktopRoot),
      readCliSessions(this.cliProjectsRoot),
    ]);
    const desktopSource = desktopResult.status === "fulfilled"
      ? desktopResult.value
      : { available: false, threads: [] };
    const cliSource = cliResult.status === "fulfilled"
      ? cliResult.value
      : { available: false, threads: [] };
    const desktop = desktopSource.threads;
    const cli = cliSource.threads;
    const importedCliIds = new Set(desktop.map((thread) => thread.cliSessionId).filter(Boolean));
    const seen = new Set();
    const threads = [...desktop, ...cli.filter((thread) => !importedCliIds.has(thread.id))]
      .filter((thread) => {
        if (seen.has(thread.id)) return false;
        seen.add(thread.id);
        return true;
      })
      .sort((a, b) => (
        b.updatedAt - a.updatedAt ||
        Number(b.claudeSessionKind === "desktop") - Number(a.claudeSessionKind === "desktop") ||
        a.id.localeCompare(b.id)
      ));

    return {
      threads,
      total: threads.length,
      diagnostics: {
        desktop: {
          available: desktopSource.available,
          loaded: desktop.length,
          path: this.desktopRoot,
          error: desktopResult.status === "rejected" ? desktopResult.reason?.message ?? String(desktopResult.reason) : null,
        },
        cli: {
          available: cliSource.available,
          loaded: cli.filter((thread) => !importedCliIds.has(thread.id)).length,
          path: this.cliProjectsRoot,
          error: cliResult.status === "rejected" ? cliResult.reason?.message ?? String(cliResult.reason) : null,
        },
      },
    };
  }
}

export const claudeThreadServiceInternals = {
  defaultDesktopRoot,
  normalizeCliSession,
  normalizeDesktopSession,
  projectForPath,
};
