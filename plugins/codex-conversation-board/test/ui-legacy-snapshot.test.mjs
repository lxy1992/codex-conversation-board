import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadSnapshotValidator() {
  const html = await readFile(resolve(ROOT, "ui/board.html"), "utf8");
  const match = html.match(
    /function isBoardSnapshot\(value\) \{([\s\S]*?)\n        \}\n\n        function structured/,
  );
  assert.ok(match, "board.html must expose the snapshot validator");
  return new Function(
    "ACTIVITY_SOURCE_VERSION",
    "ACTIVITY_STATES",
    `return function isBoardSnapshot(value) {${match[1]}\n}`,
  )(2, new Set(["idle", "active", "unread"]));
}

test("legacy board data remains renderable while activity is refreshed separately", async () => {
  const isBoardSnapshot = await loadSnapshotValidator();
  const legacySnapshot = {
    generatedAt: "2025-01-02T09:51:52.899Z",
    columns: [{ id: "inbox", label: "收件箱", description: "刚出现、尚未分类" }],
    projects: [{ id: "demo-project", name: "Demo Project", count: 1 }],
    threads: [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Codex 对话看板",
      project: { id: "demo-project", name: "Demo Project" },
      boardStatus: "inbox",
    }],
    total: 1,
    columnCounts: { inbox: 1 },
    doneLoaded: false,
  };

  assert.equal(isBoardSnapshot(legacySnapshot), true);
  assert.equal(isBoardSnapshot({ ...legacySnapshot, threads: null }), false);
});
