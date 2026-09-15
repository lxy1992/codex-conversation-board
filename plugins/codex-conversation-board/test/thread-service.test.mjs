import assert from "node:assert/strict";
import test from "node:test";
import { ThreadService } from "../server/thread-service.js";

const ACTIVE = "11111111-1111-4111-8111-111111111111";
const DONE = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const MANUAL_DONE = "44444444-4444-4444-8444-444444444444";

function rawThread(id, name) {
  return {
    id,
    name,
    cwd: "/tmp/project",
    status: { type: "idle" },
    updatedAt: 1,
  };
}

test("lazy board lookup reads active IDs but skips known completed conversations", async () => {
  const calls = { listLimits: [], readIds: [] };
  const appServer = {
    async listThreads({ limit }) {
      calls.listLimits.push(limit);
      return [rawThread(DONE, "done"), rawThread(NEW, "new")];
    },
    async readThreads(ids) {
      calls.readIds.push(...ids);
      return ids.map((id) => rawThread(id, "active"));
    },
  };
  const projectResolver = {
    async createSnapshot() {
      return {
        resolveThread: () => ({ id: "project", name: "Project", rootPaths: [] }),
      };
    },
  };
  const statusOverrides = { async load() { return new Map(); } };
  const service = new ThreadService({ appServer, projectResolver, statusOverrides });

  const threads = await service.listBoardThreads({
    activeThreadIds: [ACTIVE],
    knownThreadIds: [ACTIVE, DONE],
  });

  assert.deepEqual(calls.listLimits, [100]);
  assert.deepEqual(calls.readIds, [ACTIVE]);
  assert.deepEqual(new Set(threads.map(({ id }) => id)), new Set([ACTIVE, NEW]));
  assert.ok(!threads.some(({ id }) => id === DONE));
});

test("lazy board lookup includes today's completed metadata without reading all completed threads", async () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayDone = { ...rawThread(DONE, "today done"), updatedAt: Date.now() };
  const oldDone = { ...rawThread(NEW, "old done"), updatedAt: todayStart.getTime() - 1 };
  const calls = { listOptions: [], readIds: [] };
  const appServer = {
    async listThreads(options) {
      calls.listOptions.push(options);
      return [todayDone, oldDone];
    },
    async readThreads(ids) {
      calls.readIds.push(...ids);
      return ids.map((id) => rawThread(id, id === MANUAL_DONE ? "manually completed today" : "active"));
    },
  };
  const projectResolver = {
    async createSnapshot() {
      return { resolveThread: () => ({ id: "project", name: "Project", rootPaths: [] }) };
    },
  };
  const service = new ThreadService({
    appServer,
    projectResolver,
    statusOverrides: { async load() { return new Map(); } },
  });

  const threads = await service.listBoardThreads({
    activeThreadIds: [ACTIVE],
    previewThreadIds: [MANUAL_DONE],
    doneThreadIds: [DONE, NEW, MANUAL_DONE],
    knownThreadIds: [ACTIVE, DONE, NEW, MANUAL_DONE],
    recentDoneSince: todayStart.getTime(),
  });

  assert.equal(calls.listOptions[0].updatedSince, todayStart.getTime());
  assert.deepEqual(new Set(calls.readIds), new Set([ACTIVE, MANUAL_DONE]));
  assert.deepEqual(
    new Set(threads.map(({ id }) => id)),
    new Set([ACTIVE, DONE, MANUAL_DONE]),
  );
  assert.ok(!threads.some(({ id }) => id === NEW));
});
