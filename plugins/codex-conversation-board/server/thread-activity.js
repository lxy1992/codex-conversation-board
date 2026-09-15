import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readNativeUnreadThreadIds } from "./native-thread-state.js";

export const DEFAULT_ACTIVITY_PATH = resolve(
  homedir(),
  ".codex/conversation-board/activity.json",
);

const LIFECYCLE_TYPES = new Set(["task_started", "task_complete", "turn_aborted"]);
const UNKNOWN_LIFECYCLE = Object.freeze({
  state: "unknown",
  startedAt: null,
  completedAt: null,
});

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function emptyActivityState() {
  return { version: 2, threads: {} };
}

function sanitizeActivityState(raw) {
  const state = emptyActivityState();
  if (!raw?.threads || typeof raw.threads !== "object") return state;

  for (const [threadId, value] of Object.entries(raw.threads)) {
    if (!value || typeof value !== "object") continue;
    state.threads[threadId] = {
      seenCompletedAt: validTimestamp(value.seenCompletedAt),
      openedCompletedAt: validTimestamp(value.openedCompletedAt),
      lastCompletedAt: validTimestamp(value.lastCompletedAt),
      lastStartedAt: validTimestamp(value.lastStartedAt),
      lastState: ["active", "returned", "idle", "unknown"].includes(value.lastState)
        ? value.lastState
        : "unknown",
    };
  }
  return state;
}

function parseLifecycleLine(buffer) {
  const line = buffer.toString("utf8").trim();
  if (!line || (!line.includes("task_") && !line.includes("turn_aborted"))) return null;
  try {
    const event = JSON.parse(line);
    const type = event?.type === "event_msg" ? event?.payload?.type : null;
    if (!LIFECYCLE_TYPES.has(type)) return null;
    return { type, timestamp: validTimestamp(event.timestamp) };
  } catch {
    return null;
  }
}

/**
 * 从 JSONL 末尾反向读取最近一轮生命周期，避免为了十几张卡片扫描完整历史文件。
 */
export async function readThreadLifecycle(filePath) {
  if (!filePath) return { ...UNKNOWN_LIFECYCLE };
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    const chunkSize = 64 * 1024;
    let position = size;
    let carry = Buffer.alloc(0);
    let latestType = null;
    let startedAt = null;
    let completedAt = null;

    const accept = (event) => {
      if (!event) return;
      if (!latestType) latestType = event.type;
      if (event.type === "task_started" && !startedAt) startedAt = event.timestamp;
      if (event.type === "task_complete" && !completedAt) completedAt = event.timestamp;
    };

    while (position > 0 && !(latestType && completedAt && (latestType !== "turn_aborted" || startedAt))) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      const firstNewline = combined.indexOf(10);
      if (firstNewline < 0) {
        carry = combined;
        continue;
      }

      carry = combined.subarray(0, firstNewline);
      const complete = combined.subarray(firstNewline + 1);
      let end = complete.length;
      for (let index = complete.length - 1; index >= 0; index -= 1) {
        if (complete[index] !== 10) continue;
        accept(parseLifecycleLine(complete.subarray(index + 1, end)));
        end = index;
      }
      accept(parseLifecycleLine(complete.subarray(0, end)));
    }

    if (position === 0 && carry.length > 0) accept(parseLifecycleLine(carry));

    const state = latestType === "task_started"
      ? "active"
      : latestType === "task_complete"
        ? "returned"
        : latestType === "turn_aborted"
          ? "idle"
          : "unknown";
    return { state, startedAt, completedAt };
  } catch {
    return { ...UNKNOWN_LIFECYCLE };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function activityFrom(record, lifecycle, nativeUnread = false) {
  const startedAt = lifecycle?.startedAt ?? record?.lastStartedAt ?? null;
  const completedAt = lifecycle?.completedAt ?? record?.lastCompletedAt ?? null;
  const lifecycleState = lifecycle?.state ?? record?.lastState ?? "unknown";
  // 原生蓝点是未读的权威来源。若用户已经从看板打开过同一次完成回复，
  // 即使桌面端持久化蓝点稍有延迟，也不能在返回看板后把它重新标成未读。
  const openedCurrentReply = Boolean(
    completedAt && record?.openedCompletedAt === completedAt,
  );
  const unread = lifecycleState !== "active" && nativeUnread === true && !openedCurrentReply;
  const state = lifecycleState === "active" ? "active" : unread ? "unread" : "idle";
  return {
    state,
    label: state === "active" ? "对话中" : state === "unread" ? "新回复未读" : "",
    unread,
    startedAt,
    completedAt,
  };
}

/**
 * 保存每个对话最后一次已查看的完成时间，并基于 rollout 最新事件生成卡片状态。
 */
export class ThreadActivityTracker {
  constructor({
    filePath = process.env.CODEX_BOARD_ACTIVITY_PATH || DEFAULT_ACTIVITY_PATH,
    readLifecycle = readThreadLifecycle,
    readUnreadThreadIds = () => readNativeUnreadThreadIds(),
  } = {}) {
    this.filePath = filePath;
    this.readLifecycle = readLifecycle;
    this.readUnreadThreadIds = readUnreadThreadIds;
    this.state = null;
    this.rolloutPaths = new Map();
    this.latestLifecycles = new Map();
    this.mutationQueue = Promise.resolve();
  }

  async #load() {
    if (this.state) return this.state;
    try {
      this.state = sanitizeActivityState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.state = emptyActivityState();
    }
    return this.state;
  }

  async #persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
  }

  #mutate(callback) {
    const mutation = async () => callback(await this.#load());
    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * 读取 Codex 桌面端原生未读集合。单独暴露该轻量读取，供看板扫描完成泳道使用，
   * 避免为了判断是否有新回复而预读取数百个已完成对话的历史文件。
   */
  async nativeUnreadThreadIds() {
    const threadIds = await this.readUnreadThreadIds();
    return threadIds instanceof Set ? new Set(threadIds) : new Set();
  }

  async observeThreads(threads, { nativeUnreadIds = null } = {}) {
    const candidates = threads.filter((thread) => thread?.id);
    for (const thread of candidates) {
      if (thread.rolloutPath) this.rolloutPaths.set(thread.id, thread.rolloutPath);
    }
    const [observed, observedNativeUnreadIds] = await Promise.all([
      Promise.all(candidates.map(async (thread) => [
        thread.id,
        thread.rolloutPath
          ? await this.readLifecycle(thread.rolloutPath)
          : this.latestLifecycles.get(thread.id) ?? { ...UNKNOWN_LIFECYCLE },
      ])),
      nativeUnreadIds instanceof Set
        ? Promise.resolve(nativeUnreadIds)
        : this.nativeUnreadThreadIds().catch(() => null),
    ]);
    for (const [threadId, lifecycle] of observed) this.latestLifecycles.set(threadId, lifecycle);

    return this.#mutate(async (state) => {
      let changed = false;
      const activities = {};
      for (const [threadId, lifecycle] of observed) {
        let record = state.threads[threadId];
        if (!record) {
          record = {
            // 保留旧版基线字段用于兼容已有 activity.json；真正的未读来自原生状态，
            // 从看板打开的完成回复则单独记录在 openedCompletedAt。
            seenCompletedAt: lifecycle.completedAt,
            openedCompletedAt: null,
            lastCompletedAt: lifecycle.completedAt,
            lastStartedAt: lifecycle.startedAt,
            lastState: lifecycle.state,
          };
          state.threads[threadId] = record;
          changed = true;
        } else {
          const nextValues = {
            lastCompletedAt: lifecycle.completedAt ?? record.lastCompletedAt,
            lastStartedAt: lifecycle.startedAt ?? record.lastStartedAt,
            lastState: lifecycle.state,
          };
          for (const [key, value] of Object.entries(nextValues)) {
            if (record[key] === value) continue;
            record[key] = value;
            changed = true;
          }
        }
        activities[threadId] = activityFrom(
          record,
          lifecycle,
          observedNativeUnreadIds instanceof Set && observedNativeUnreadIds.has(threadId),
        );
      }
      if (changed) await this.#persist();
      return activities;
    });
  }

  async refresh(threadIds, { nativeUnreadIds = null } = {}) {
    const ids = [...new Set(threadIds)].filter(Boolean);
    const known = ids.map((threadId) => ({
      id: threadId,
      rolloutPath: this.rolloutPaths.get(threadId) ?? null,
    }));
    const refreshed = await this.observeThreads(known, { nativeUnreadIds });
    const state = await this.#load();
    for (const threadId of ids) {
      if (refreshed[threadId]) continue;
      refreshed[threadId] = activityFrom(
        state.threads[threadId],
        this.latestLifecycles.get(threadId),
        false,
      );
    }
    return refreshed;
  }

  async markSeen(threadId) {
    return this.#mutate(async (state) => {
      const record = state.threads[threadId] ?? {
        seenCompletedAt: null,
        openedCompletedAt: null,
        lastCompletedAt: null,
        lastStartedAt: null,
        lastState: "unknown",
      };
      state.threads[threadId] = record;
      const changed = record.openedCompletedAt !== record.lastCompletedAt;
      record.seenCompletedAt = record.lastCompletedAt;
      record.openedCompletedAt = record.lastCompletedAt;
      if (changed) await this.#persist();
      return activityFrom(record, this.latestLifecycles.get(threadId));
    });
  }
}

export const threadActivityInternals = {
  activityFrom,
  emptyActivityState,
  sanitizeActivityState,
};
