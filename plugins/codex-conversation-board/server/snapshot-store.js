import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const DEFAULT_SNAPSHOT_PATH = resolve(
  homedir(),
  ".codex/conversation-board/fast-snapshot.json",
);
export const SNAPSHOT_ACTIVITY_SOURCE_VERSION = 2;
export const SNAPSHOT_VERSION = 2;

const ACTIVITY_STATES = new Set(["idle", "active", "unread"]);

function hasCurrentActivity(thread) {
  return Boolean(
    thread?.activity &&
    ACTIVITY_STATES.has(thread.activity.state) &&
    typeof thread.activity.unread === "boolean",
  );
}

function isSnapshot(value) {
  return Boolean(
    value &&
    value.snapshotVersion === SNAPSHOT_VERSION &&
    value.activitySourceVersion === SNAPSHOT_ACTIVITY_SOURCE_VERSION &&
    value.donePreviewMode === "today" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.donePreviewDate) &&
    Number.isInteger(value.donePreviewCount) &&
    Array.isArray(value.columns) &&
    Array.isArray(value.projects) &&
    Array.isArray(value.threads) &&
    value.threads.every(hasCurrentActivity) &&
    value.columnCounts &&
    typeof value.columnCounts === "object",
  );
}

export class SnapshotStore {
  constructor({ filePath = process.env.CODEX_BOARD_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH } = {}) {
    this.filePath = filePath;
    this.snapshot = null;
  }

  async load() {
    if (this.snapshot) return structuredClone(this.snapshot);
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isSnapshot(parsed)) return null;
      this.snapshot = parsed;
      return structuredClone(parsed);
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async save(snapshot) {
    if (!isSnapshot(snapshot)) throw new Error("Cannot persist an incomplete board snapshot");
    this.snapshot = structuredClone(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
  }
}

export const snapshotStoreInternals = { isSnapshot };
