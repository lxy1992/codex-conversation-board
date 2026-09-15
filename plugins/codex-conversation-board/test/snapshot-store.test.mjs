import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SnapshotStore } from "../server/snapshot-store.js";

test("persists and reloads a compact board snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-snapshot-"));
  const filePath = join(directory, "snapshot.json");
  const snapshot = {
    snapshotVersion: 2,
    activitySourceVersion: 2,
    columns: [{ id: "inbox", label: "收件箱" }],
    projects: [],
    threads: [],
    total: 0,
    columnCounts: { inbox: 0 },
    doneLoaded: false,
    donePreviewMode: "today",
    donePreviewDate: "2026-08-31",
    donePreviewCount: 0,
  };
  await new SnapshotStore({ filePath }).save(snapshot);
  assert.deepEqual(await new SnapshotStore({ filePath }).load(), snapshot);
});

test("rejects an old fast snapshot that cannot contain today's completed preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-old-snapshot-"));
  const filePath = join(directory, "snapshot.json");
  const store = new SnapshotStore({ filePath });
  await assert.rejects(
    store.save({
      activitySourceVersion: 2,
      columns: [],
      projects: [],
      threads: [],
      columnCounts: {},
      doneLoaded: false,
    }),
    /incomplete board snapshot/,
  );
});
