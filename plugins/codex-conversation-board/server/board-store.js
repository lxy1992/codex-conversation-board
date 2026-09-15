import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BOARD_COLUMNS, normalizeBoardColumns } from "./constants.js";

export const DEFAULT_BOARD_PATH = resolve(homedir(), ".codex/conversation-board/board.json");

function defaultColumnDefinitions() {
  return BOARD_COLUMNS.map((column) => ({ ...column }));
}

function emptyBoard(columnDefinitions = defaultColumnDefinitions()) {
  const normalizedColumns = normalizeBoardColumns(columnDefinitions);
  return {
    version: 3,
    updatedAt: null,
    columnDefinitions: normalizedColumns,
    columns: Object.fromEntries(normalizedColumns.map(({ id }) => [id, []])),
    statusChangedAt: {},
  };
}

function sanitizeBoard(raw) {
  let columnDefinitions = defaultColumnDefinitions();
  if (Array.isArray(raw?.columnDefinitions)) {
    try {
      columnDefinitions = normalizeBoardColumns(raw.columnDefinitions);
    } catch {
      // 配置文件若被手工写坏，回退到默认状态，并在下方把未知泳道卡片收回收件箱。
    }
  }
  const board = emptyBoard(columnDefinitions);
  const seen = new Set();
  board.updatedAt = typeof raw?.updatedAt === "string" ? raw.updatedAt : null;

  for (const { id } of columnDefinitions) {
    const ids = Array.isArray(raw?.columns?.[id]) ? raw.columns[id] : [];
    board.columns[id] = ids.filter((threadId) => {
      if (typeof threadId !== "string" || seen.has(threadId)) return false;
      seen.add(threadId);
      return true;
    });
  }
  const configuredIds = new Set(columnDefinitions.map(({ id }) => id));
  for (const [id, ids] of Object.entries(raw?.columns ?? {})) {
    if (configuredIds.has(id) || !Array.isArray(ids)) continue;
    for (const threadId of ids) {
      if (typeof threadId !== "string" || seen.has(threadId)) continue;
      seen.add(threadId);
      board.columns.inbox.push(threadId);
    }
  }
  for (const [threadId, changedAt] of Object.entries(raw?.statusChangedAt ?? {})) {
    if (!seen.has(threadId) || typeof changedAt !== "string" || Number.isNaN(Date.parse(changedAt))) continue;
    board.statusChangedAt[threadId] = changedAt;
  }
  return board;
}

export class BoardStore {
  constructor({
    filePath = process.env.CODEX_BOARD_STATE_PATH || DEFAULT_BOARD_PATH,
    now = () => new Date(),
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.board = null;
    this.mutationQueue = Promise.resolve();
  }

  async load({ force = false } = {}) {
    if (this.board && !force) return this.board;
    try {
      this.board = sanitizeBoard(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.board = emptyBoard();
    }
    return this.board;
  }

  async snapshot({ force = false } = {}) {
    return structuredClone(await this.load({ force }));
  }

  async #persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.board, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
  }

  async moveThread(threadId, targetStatus, beforeThreadId = null) {
    const mutation = async () => {
      // Codex 内嵌看板和本机网页版可能由两个 Node 进程同时持有各自缓存。
      // 每次写入前都重新读取磁盘，避免一个入口用旧缓存覆盖另一个入口刚保存的泳道。
      await this.load({ force: true });
      if (!Object.hasOwn(this.board.columns, targetStatus)) {
        throw new Error(`Invalid board status: ${targetStatus}`);
      }
      let sourceStatus = null;
      for (const [status, ids] of Object.entries(this.board.columns)) {
        const index = ids.indexOf(threadId);
        if (index >= 0) {
          sourceStatus = status;
          ids.splice(index, 1);
        }
      }

      const target = this.board.columns[targetStatus];
      const beforeIndex = beforeThreadId ? target.indexOf(beforeThreadId) : -1;
      target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, threadId);
      const changedAt = this.now().toISOString();
      if (sourceStatus !== targetStatus || !this.board.statusChangedAt[threadId]) {
        this.board.statusChangedAt[threadId] = changedAt;
      }
      this.board.updatedAt = changedAt;
      await this.#persist();
      return structuredClone(this.board);
    };

    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * 首次建立某个来源的看板时一次性写入基线，避免几千条历史对话全部涌入收件箱。
   * 只会作用于从未保存过状态的空看板，之后刷新不会覆盖用户手动流转的结果。
   */
  async initializeIfEmpty(assignments) {
    const mutation = async () => {
      await this.load({ force: true });
      const hasSavedState = this.board.updatedAt != null || Object.values(this.board.columns).some(
        (threadIds) => threadIds.length > 0,
      );
      if (hasSavedState) {
        return { board: structuredClone(this.board), initialized: false };
      }

      const seen = new Set();
      for (const assignment of assignments ?? []) {
        const threadId = assignment?.threadId;
        const status = assignment?.status;
        if (typeof threadId !== "string" || seen.has(threadId) || !Object.hasOwn(this.board.columns, status)) continue;
        seen.add(threadId);
        this.board.columns[status].push(threadId);
        const changedAt = typeof assignment.changedAt === "string" && !Number.isNaN(Date.parse(assignment.changedAt))
          ? assignment.changedAt
          : this.now().toISOString();
        this.board.statusChangedAt[threadId] = changedAt;
      }
      // 即使当前没有对话也记录“已初始化”。否则用户日后创建第一条 Chat 时，
      // 它会被误当成安装前历史而进入完成列，而不是正常出现在收件箱。
      this.board.updatedAt = this.now().toISOString();
      await this.#persist();
      return { board: structuredClone(this.board), initialized: true };
    };

    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * 保存当前来源的状态定义和泳道顺序。被删除泳道里的卡片会按旧泳道顺序迁移到
   * 用户选择的保留状态，避免自定义工作流时丢失任何对话。
   */
  async updateColumns(columnDefinitions, { migrationTarget = "inbox" } = {}) {
    const nextDefinitions = normalizeBoardColumns(columnDefinitions);
    const nextIds = new Set(nextDefinitions.map(({ id }) => id));
    if (!nextIds.has(migrationTarget)) throw new Error("卡片迁移目标必须是保留的状态");

    const mutation = async () => {
      await this.load({ force: true });
      const removedIds = this.board.columnDefinitions
        .map(({ id }) => id)
        .filter((id) => !nextIds.has(id));
      const migratedThreadIds = removedIds.flatMap((id) => this.board.columns[id] ?? []);
      const nextColumns = Object.fromEntries(nextDefinitions.map(({ id }) => [
        id,
        Array.isArray(this.board.columns[id]) ? [...this.board.columns[id]] : [],
      ]));
      const targetIds = nextColumns[migrationTarget];
      const alreadyInTarget = new Set(targetIds);
      for (const threadId of migratedThreadIds) {
        if (alreadyInTarget.has(threadId)) continue;
        alreadyInTarget.add(threadId);
        targetIds.push(threadId);
      }

      const changedAt = this.now().toISOString();
      for (const threadId of migratedThreadIds) this.board.statusChangedAt[threadId] = changedAt;
      this.board = {
        ...this.board,
        version: 3,
        updatedAt: changedAt,
        columnDefinitions: nextDefinitions,
        columns: nextColumns,
      };
      await this.#persist();
      return {
        board: structuredClone(this.board),
        removedStatusIds: removedIds,
        migratedThreadIds,
        migrationTarget,
      };
    };

    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * 将“完成”泳道里重新出现未读回复的对话移回收件箱顶部。
   * 只移动当前仍在完成泳道里的 ID，重复扫描不会改变已经恢复的对话顺序。
   */
  async reopenDoneThreads(threadIds) {
    const candidates = new Set(
      [...threadIds].filter((threadId) => typeof threadId === "string" && threadId),
    );

    const mutation = async () => {
      // 网页版和 Codex 内嵌版可能同时写 board.json；移动前必须读取最新磁盘状态。
      await this.load({ force: true });
      const movedThreadIds = this.board.columns.done.filter((threadId) => candidates.has(threadId));
      if (movedThreadIds.length > 0) {
        const moved = new Set(movedThreadIds);
        this.board.columns.done = this.board.columns.done.filter((threadId) => !moved.has(threadId));
        this.board.columns.inbox = [
          ...movedThreadIds,
          ...this.board.columns.inbox.filter((threadId) => !moved.has(threadId)),
        ];
        const changedAt = this.now().toISOString();
        for (const threadId of movedThreadIds) this.board.statusChangedAt[threadId] = changedAt;
        this.board.updatedAt = changedAt;
        await this.#persist();
      }

      return {
        board: structuredClone(this.board),
        movedThreadIds,
      };
    };

    const next = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  async arrangeThreads(threads, { force = false, board: boardSnapshot = null } = {}) {
    const board = boardSnapshot ?? await this.load({ force });
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const storedIds = new Set(Object.values(board.columns).flat());
    const arranged = [];

    for (const { id: status } of board.columnDefinitions) {
      let position = 0;
      for (const threadId of board.columns[status]) {
        const thread = byId.get(threadId);
        if (!thread) continue;
        arranged.push({
          ...thread,
          boardStatus: status,
          boardPosition: position++,
          boardStatusChangedAt: board.statusChangedAt[threadId] ?? null,
        });
      }

      if (status === "inbox") {
        for (const thread of threads) {
          if (storedIds.has(thread.id)) continue;
          arranged.push({
            ...thread,
            boardStatus: "inbox",
            boardPosition: position++,
            boardStatusChangedAt: null,
          });
        }
      }
    }

    return arranged;
  }
}

export const boardStoreInternals = { defaultColumnDefinitions, emptyBoard, sanitizeBoard };
