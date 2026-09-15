import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ThreadActivityTracker,
  readThreadLifecycle,
} from "../server/thread-activity.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const UNREAD_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_COMPLETE = "2026-08-28T01:00:00.000Z";
const SECOND_START = "2026-08-28T02:00:00.000Z";
const SECOND_COMPLETE = "2026-08-28T03:00:00.000Z";
const THIRD_START = "2026-08-28T04:00:00.000Z";
const THIRD_ABORT = "2026-08-28T05:00:00.000Z";

function event(timestamp, type) {
  return `${JSON.stringify({ timestamp, type: "event_msg", payload: { type } })}\n`;
}

test("reads active, returned, and aborted lifecycle states from the rollout tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-lifecycle-"));
  const filePath = join(directory, "rollout.jsonl");
  const largeUnrelatedLine = `${JSON.stringify({
    timestamp: "2026-08-28T01:30:00.000Z",
    type: "response_item",
    payload: { type: "reasoning", encrypted_content: "x".repeat(90_000) },
  })}\n`;

  await writeFile(
    filePath,
    event(FIRST_COMPLETE, "task_complete") + largeUnrelatedLine + event(SECOND_START, "task_started"),
  );
  let lifecycle = await readThreadLifecycle(filePath);
  assert.equal(lifecycle.state, "active");
  assert.equal(lifecycle.startedAt, SECOND_START);
  assert.equal(lifecycle.completedAt, FIRST_COMPLETE);

  await appendFile(filePath, event(SECOND_COMPLETE, "task_complete"));
  lifecycle = await readThreadLifecycle(filePath);
  assert.equal(lifecycle.state, "returned");
  assert.equal(lifecycle.completedAt, SECOND_COMPLETE);

  await appendFile(
    filePath,
    event(THIRD_START, "task_started") + event(THIRD_ABORT, "turn_aborted"),
  );
  lifecycle = await readThreadLifecycle(filePath);
  assert.equal(lifecycle.state, "idle");
  assert.equal(lifecycle.startedAt, THIRD_START);
  assert.equal(lifecycle.completedAt, SECOND_COMPLETE);
});

test("tracks lifecycle while unread follows the Codex native state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-activity-"));
  const filePath = join(directory, "activity.json");
  const lifecycleByPath = new Map([
    ["rollout-one", { state: "returned", startedAt: null, completedAt: FIRST_COMPLETE }],
  ]);
  const readLifecycle = async (rolloutPath) => lifecycleByPath.get(rolloutPath);
  const nativeUnread = new Set();
  const tracker = new ThreadActivityTracker({
    filePath,
    readLifecycle,
    readUnreadThreadIds: async () => new Set(nativeUnread),
  });
  const threads = [{ id: THREAD_ID, rolloutPath: "rollout-one" }];

  let activities = await tracker.observeThreads(threads);
  assert.deepEqual(activities[THREAD_ID], {
    state: "idle",
    label: "",
    unread: false,
    startedAt: null,
    completedAt: FIRST_COMPLETE,
  });

  lifecycleByPath.set("rollout-one", {
    state: "active",
    startedAt: SECOND_START,
    completedAt: FIRST_COMPLETE,
  });
  activities = await tracker.refresh([THREAD_ID]);
  assert.equal(activities[THREAD_ID].state, "active");
  assert.equal(activities[THREAD_ID].label, "对话中");

  lifecycleByPath.set("rollout-one", {
    state: "returned",
    startedAt: SECOND_START,
    completedAt: SECOND_COMPLETE,
  });
  nativeUnread.add(THREAD_ID);
  activities = await tracker.refresh([THREAD_ID]);
  assert.equal(activities[THREAD_ID].state, "unread");
  assert.equal(activities[THREAD_ID].label, "新回复未读");
  assert.equal(activities[THREAD_ID].unread, true);

  nativeUnread.delete(THREAD_ID);
  activities = await tracker.refresh([THREAD_ID]);
  assert.equal(activities[THREAD_ID].state, "idle");
  assert.equal(activities[THREAD_ID].unread, false);

  const reloaded = new ThreadActivityTracker({
    filePath,
    readLifecycle,
    readUnreadThreadIds: async () => new Set(nativeUnread),
  });
  activities = await reloaded.observeThreads(threads);
  assert.equal(activities[THREAD_ID].unread, false);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.threads[THREAD_ID].lastCompletedAt, SECOND_COMPLETE);
});

test("uses Codex native unread state without conflating it with an active turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-native-state-"));
  const filePath = join(directory, "activity.json");
  const lifecycleByPath = new Map([
    ["rollout-active", {
      state: "active",
      startedAt: SECOND_START,
      completedAt: FIRST_COMPLETE,
    }],
    ["rollout-unread", {
      state: "returned",
      startedAt: SECOND_START,
      completedAt: SECOND_COMPLETE,
    }],
  ]);
  const tracker = new ThreadActivityTracker({
    filePath,
    readLifecycle: async (rolloutPath) => lifecycleByPath.get(rolloutPath),
    readUnreadThreadIds: async () => new Set([ACTIVE_THREAD_ID, UNREAD_THREAD_ID]),
  });

  const activities = await tracker.observeThreads([
    { id: ACTIVE_THREAD_ID, rolloutPath: "rollout-active" },
    { id: UNREAD_THREAD_ID, rolloutPath: "rollout-unread" },
  ]);

  assert.equal(activities[ACTIVE_THREAD_ID].state, "active");
  assert.equal(activities[ACTIVE_THREAD_ID].unread, false);
  assert.equal(activities[UNREAD_THREAD_ID].state, "unread");
  assert.equal(activities[UNREAD_THREAD_ID].label, "新回复未读");
  assert.equal(activities[UNREAD_THREAD_ID].unread, true);
});

test("keeps native unread state for a thread without a rollout path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-no-rollout-"));
  const tracker = new ThreadActivityTracker({
    filePath: join(directory, "activity.json"),
    readUnreadThreadIds: async () => new Set([UNREAD_THREAD_ID]),
  });

  let activities = await tracker.observeThreads([{ id: UNREAD_THREAD_ID, rolloutPath: null }]);
  assert.equal(activities[UNREAD_THREAD_ID].state, "unread");

  activities = await tracker.refresh([UNREAD_THREAD_ID]);
  assert.equal(activities[UNREAD_THREAD_ID].state, "unread");
});

test("opening an unread card keeps that completed reply read after returning to the board", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-opened-unread-"));
  const lifecycleByPath = new Map([
    ["rollout-unread", {
      state: "returned",
      startedAt: SECOND_START,
      completedAt: SECOND_COMPLETE,
    }],
  ]);
  const tracker = new ThreadActivityTracker({
    filePath: join(directory, "activity.json"),
    readLifecycle: async (rolloutPath) => lifecycleByPath.get(rolloutPath),
    // Reproduce the desktop persistence lag: its blue-dot set can still contain
    // the task briefly after a deep-link navigation has shown the reply.
    readUnreadThreadIds: async () => new Set([UNREAD_THREAD_ID]),
  });

  let activities = await tracker.observeThreads([
    { id: UNREAD_THREAD_ID, rolloutPath: "rollout-unread" },
  ]);
  assert.equal(activities[UNREAD_THREAD_ID].state, "unread");

  await tracker.markSeen(UNREAD_THREAD_ID);
  activities = await tracker.refresh([UNREAD_THREAD_ID]);
  assert.equal(activities[UNREAD_THREAD_ID].state, "idle");

  lifecycleByPath.set("rollout-unread", {
    state: "returned",
    startedAt: THIRD_START,
    completedAt: "2026-08-28T06:00:00.000Z",
  });
  activities = await tracker.refresh([UNREAD_THREAD_ID]);
  assert.equal(activities[UNREAD_THREAD_ID].state, "unread");
});
