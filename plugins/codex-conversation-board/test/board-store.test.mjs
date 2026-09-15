import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoardStore } from "../server/board-store.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

test("moves and orders a conversation without losing unclassified threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-plugin-"));
  const filePath = join(directory, "board.json");
  const store = new BoardStore({ filePath });
  const threads = [
    { id: FIRST, title: "first" },
    { id: SECOND, title: "second" },
  ];

  await store.moveThread(SECOND, "doing");
  await store.moveThread(FIRST, "doing", SECOND);
  const arranged = await store.arrangeThreads(threads);

  assert.deepEqual(
    arranged.map(({ id, boardStatus, boardPosition }) => ({ id, boardStatus, boardPosition })),
    [
      { id: FIRST, boardStatus: "doing", boardPosition: 0 },
      { id: SECOND, boardStatus: "doing", boardPosition: 1 },
    ],
  );

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(persisted.columns.doing, [FIRST, SECOND]);
});

test("sequential writes from the Codex UI and web UI do not overwrite each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-shared-store-"));
  const filePath = join(directory, "board.json");
  const codexStore = new BoardStore({ filePath });
  const webStore = new BoardStore({ filePath });

  await codexStore.moveThread(FIRST, "doing");
  await webStore.moveThread(SECOND, "blocked");
  await codexStore.moveThread(FIRST, "review");

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(persisted.columns.review, [FIRST]);
  assert.deepEqual(persisted.columns.blocked, [SECOND]);
});

test("moves completed conversations with new replies back to the front of inbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-reopen-done-"));
  const filePath = join(directory, "board.json");
  const store = new BoardStore({ filePath });

  await store.moveThread(SECOND, "inbox");
  await store.moveThread(FIRST, "done");
  const firstResult = await store.reopenDoneThreads([FIRST]);

  assert.deepEqual(firstResult.movedThreadIds, [FIRST]);
  assert.deepEqual(firstResult.board.columns.inbox, [FIRST, SECOND]);
  assert.deepEqual(firstResult.board.columns.done, []);

  const secondResult = await store.reopenDoneThreads([FIRST]);
  assert.deepEqual(secondResult.movedThreadIds, []);
  assert.deepEqual(secondResult.board.columns.inbox, [FIRST, SECOND]);
});

test("records when a conversation enters the completed lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-completed-at-"));
  const filePath = join(directory, "board.json");
  let now = new Date("2026-08-31T03:00:00.000Z");
  const store = new BoardStore({ filePath, now: () => now });

  await store.moveThread(FIRST, "done");
  assert.equal((await store.snapshot()).statusChangedAt[FIRST], "2026-08-31T03:00:00.000Z");

  now = new Date("2026-09-01T03:00:00.000Z");
  await store.moveThread(FIRST, "done");
  assert.equal(
    (await store.snapshot()).statusChangedAt[FIRST],
    "2026-08-31T03:00:00.000Z",
    "reordering inside completed must not change the completion day",
  );

  await store.moveThread(FIRST, "inbox");
  assert.equal((await store.snapshot()).statusChangedAt[FIRST], "2026-09-01T03:00:00.000Z");
});

test("initializes a history baseline once without overwriting later user moves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-initialize-"));
  const filePath = join(directory, "board.json");
  const store = new BoardStore({ filePath });

  const first = await store.initializeIfEmpty([
    { threadId: FIRST, status: "todo", changedAt: "2026-09-01T01:00:00.000Z" },
    { threadId: SECOND, status: "done", changedAt: "2026-08-01T01:00:00.000Z" },
  ]);
  assert.equal(first.initialized, true);
  assert.deepEqual(first.board.columns.todo, [FIRST]);
  assert.deepEqual(first.board.columns.done, [SECOND]);
  assert.equal(first.board.statusChangedAt[SECOND], "2026-08-01T01:00:00.000Z");

  await store.moveThread(FIRST, "doing");
  const second = await store.initializeIfEmpty([
    { threadId: FIRST, status: "done" },
  ]);
  assert.equal(second.initialized, false);
  assert.deepEqual(second.board.columns.doing, [FIRST]);
  assert.deepEqual(second.board.columns.done, [SECOND]);
});

test("an empty first sync still lets future conversations enter inbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-empty-initialize-"));
  const store = new BoardStore({ filePath: join(directory, "board.json") });

  const first = await store.initializeIfEmpty([]);
  assert.equal(first.initialized, true);

  const second = await store.initializeIfEmpty([
    { threadId: FIRST, status: "done" },
  ]);
  assert.equal(second.initialized, false);
  const arranged = await store.arrangeThreads([{ id: FIRST, updatedAt: 1 }]);
  assert.equal(arranged[0].boardStatus, "inbox");
});

test("persists custom statuses, their order, and migrates cards from deleted lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-custom-columns-"));
  const filePath = join(directory, "board.json");
  const store = new BoardStore({ filePath });

  await store.moveThread(FIRST, "todo");
  await store.moveThread(SECOND, "blocked");
  const result = await store.updateColumns([
    { id: "inbox", label: "新任务", description: "等待分类", color: "#64748B" },
    { id: "doing", label: "处理中", description: "当前正在推进", color: "#7C3AED" },
    { id: "waiting-release", label: "等待发布", description: "等待上线", color: "#D97706" },
    { id: "done", label: "已归档", description: "已经结束", color: "#15803D" },
  ], { migrationTarget: "doing" });

  assert.deepEqual(result.board.columnDefinitions.map(({ id }) => id), [
    "inbox",
    "doing",
    "waiting-release",
    "done",
  ]);
  assert.equal(result.board.columnDefinitions[0].required, true);
  assert.equal(result.board.columnDefinitions[2].required, false);
  assert.deepEqual(result.migratedThreadIds, [FIRST, SECOND]);
  assert.deepEqual(result.board.columns.doing, [FIRST, SECOND]);
  assert.equal(result.board.columns.todo, undefined);
  assert.equal(result.board.columns.blocked, undefined);

  await store.moveThread(FIRST, "waiting-release");
  const reloaded = await new BoardStore({ filePath }).snapshot();
  assert.deepEqual(reloaded.columnDefinitions.map(({ id }) => id), [
    "inbox",
    "doing",
    "waiting-release",
    "done",
  ]);
  assert.deepEqual(reloaded.columns["waiting-release"], [FIRST]);
});

test("requires the inbox and done system statuses in every configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-required-columns-"));
  const store = new BoardStore({ filePath: join(directory, "board.json") });

  await assert.rejects(
    store.updateColumns([
      { id: "doing", label: "处理中", color: "#7C3AED" },
      { id: "done", label: "完成", color: "#15803D" },
    ]),
    /收件箱.*不能删除/,
  );
  await assert.rejects(
    store.updateColumns([
      { id: "inbox", label: "收件箱", color: "#64748B" },
      { id: "doing", label: "处理中", color: "#7C3AED" },
    ]),
    /完成.*不能删除/,
  );
});

test("upgrades a legacy board to default column definitions without losing cards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-legacy-columns-"));
  const filePath = join(directory, "board.json");
  await writeFile(filePath, JSON.stringify({
    version: 2,
    updatedAt: "2026-09-01T00:00:00.000Z",
    columns: {
      inbox: [],
      todo: [],
      doing: [FIRST],
      blocked: [],
      review: [],
      done: [SECOND],
    },
    statusChangedAt: {
      [FIRST]: "2026-09-01T00:00:00.000Z",
      [SECOND]: "2026-09-01T00:00:00.000Z",
    },
  }));

  const snapshot = await new BoardStore({ filePath }).snapshot();
  assert.equal(snapshot.version, 3);
  assert.deepEqual(snapshot.columnDefinitions.map(({ id }) => id), [
    "inbox",
    "todo",
    "doing",
    "blocked",
    "review",
    "done",
  ]);
  assert.deepEqual(snapshot.columns.doing, [FIRST]);
  assert.deepEqual(snapshot.columns.done, [SECOND]);
});
