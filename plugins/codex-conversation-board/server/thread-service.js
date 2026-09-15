import { readFile } from "node:fs/promises";
import { timestampMs } from "./time.js";

function cleanText(value, fallback) {
  const result = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!result) return fallback;
  return result.length > 180 ? `${result.slice(0, 177)}…` : result;
}

export function normalizeRuntimeStatus(status) {
  const type = status?.type ?? "notLoaded";
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
  if (type === "active" && flags.includes("waitingOnApproval")) {
    return { type, state: "approval", label: "等待审批", exact: true };
  }
  if (type === "active" && flags.includes("waitingOnUserInput")) {
    return { type, state: "input", label: "等待输入", exact: true };
  }
  if (type === "active") return { type, state: "active", label: "运行中", exact: true };
  if (type === "idle") return { type, state: "idle", label: "空闲", exact: true };
  if (type === "systemError") return { type, state: "error", label: "异常", exact: true };
  return { type: "notLoaded", state: "unknown", label: "未加载", exact: false };
}

function sourceLabel(source) {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") return Object.keys(source)[0] ?? "unknown";
  return "unknown";
}

export function normalizeThread(thread, project, statusOverride = null) {
  const status = statusOverride ?? thread.status;
  return {
    id: thread.id,
    title: cleanText(thread.name || thread.preview, "未命名对话"),
    preview: cleanText(thread.preview, ""),
    cwd: thread.cwd ?? null,
    project: {
      id: project.id,
      name: project.name,
      rootPaths: project.rootPaths,
    },
    runtime: normalizeRuntimeStatus(status),
    updatedAt: thread.updatedAt ?? thread.recencyAt ?? thread.createdAt ?? 0,
    createdAt: thread.createdAt ?? 0,
    branch: thread.gitInfo?.branch ?? null,
    repository: thread.gitInfo?.originUrl ?? null,
    source: sourceLabel(thread.source),
    rolloutPath: thread.path ?? thread.rolloutPath ?? null,
    openUrl: `codex://threads/${thread.id}`,
  };
}

export class RuntimeStatusOverrides {
  constructor({ filePath = process.env.CODEX_BOARD_STATUS_FILE } = {}) {
    this.filePath = filePath;
  }

  async load() {
    if (!this.filePath) return new Map();
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      const values = raw.threads ?? raw;
      return new Map(Object.entries(values));
    } catch {
      return new Map();
    }
  }
}

export class ThreadService {
  constructor({ appServer, projectResolver, statusOverrides = new RuntimeStatusOverrides(), cacheTtlMs = 20_000 }) {
    this.appServer = appServer;
    this.projectResolver = projectResolver;
    this.statusOverrides = statusOverrides;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.inFlight = null;
  }

  invalidate() {
    this.cache = null;
  }

  async listThreads({ limit = 1_200, force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.createdAt < this.cacheTtlMs) {
      return this.cache.threads.slice(0, limit);
    }
    if (this.inFlight) return (await this.inFlight).slice(0, limit);

    this.inFlight = this.#refresh(Math.max(limit, 1_200));
    try {
      const threads = await this.inFlight;
      return threads.slice(0, limit);
    } finally {
      this.inFlight = null;
    }
  }

  async listBoardThreads({
    activeThreadIds = [],
    previewThreadIds = [],
    doneThreadIds = [],
    knownThreadIds = [],
    recentLimit = 100,
    recentDoneSince = null,
    force = false,
  } = {}) {
    const activeIds = new Set(activeThreadIds);
    const previewIds = new Set(previewThreadIds);
    const requiredIds = new Set([...activeIds, ...previewIds]);
    const doneIds = new Set(doneThreadIds);
    const knownIds = new Set(knownThreadIds);
    const shouldInclude = (thread) => {
      if (requiredIds.has(thread.id) || !knownIds.has(thread.id)) return true;
      const updatedAt = timestampMs(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt);
      return recentDoneSince != null && doneIds.has(thread.id) && updatedAt != null && updatedAt >= recentDoneSince;
    };

    // A forced refresh is the correctness escape hatch: scan everything so imported or
    // unusually old conversations can still be discovered. A brand-new board also needs
    // one complete scan because it has no known IDs from which to build a lazy snapshot.
    if (force || knownIds.size === 0) {
      const threads = await this.listThreads({ limit: 1_200, force });
      if (knownIds.size === 0) return threads;
      return threads.filter(shouldInclude);
    }

    const now = Date.now();
    if (this.cache && now - this.cache.createdAt < this.cacheTtlMs) {
      return this.cache.threads.filter(shouldInclude);
    }

    const [recentThreads, projectSnapshot, overrides] = await Promise.all([
      this.appServer.listThreads({
        limit: recentDoneSince == null ? recentLimit : 1_200,
        ...(recentDoneSince == null ? {} : { updatedSince: recentDoneSince }),
      }),
      this.projectResolver.createSnapshot(),
      this.statusOverrides.load(),
    ]);
    const selectedById = new Map();

    for (const thread of recentThreads) {
      if (shouldInclude(thread)) {
        selectedById.set(thread.id, thread);
      }
    }

    const missingRequiredIds = [...requiredIds].filter((threadId) => !selectedById.has(threadId));
    for (const thread of await this.appServer.readThreads(missingRequiredIds)) {
      selectedById.set(thread.id, thread);
    }

    return [...selectedById.values()]
      .filter((thread) => !thread.ephemeral && !thread.parentThreadId)
      .map((thread) =>
        normalizeThread(thread, projectSnapshot.resolveThread(thread), overrides.get(thread.id)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async #refresh(limit) {
    const [rawThreads, projectSnapshot, overrides] = await Promise.all([
      this.appServer.listThreads({ limit }),
      this.projectResolver.createSnapshot(),
      this.statusOverrides.load(),
    ]);

    const threads = rawThreads
      .filter((thread) => !thread.ephemeral && !thread.parentThreadId)
      .map((thread) =>
        normalizeThread(thread, projectSnapshot.resolveThread(thread), overrides.get(thread.id)),
      );

    this.cache = { createdAt: Date.now(), threads };
    return threads;
  }
}
