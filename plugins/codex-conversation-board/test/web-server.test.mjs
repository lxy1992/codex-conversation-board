import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBoardWebServer } from "../server/web-server.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function snapshot() {
  return {
    generatedAt: "2025-01-02T00:00:00.000Z",
    activitySourceVersion: 2,
    columns: [{ id: "inbox", label: "收件箱", description: "刚出现、尚未分类" }],
    projects: [{ id: "demo-project", name: "Demo Project", count: 1 }],
    threads: [{
      id: THREAD_ID,
      title: "网页看板测试",
      project: { id: "demo-project", name: "Demo Project" },
      activity: { state: "idle", label: "", unread: false },
      boardStatus: "inbox",
      boardPosition: 0,
    }],
    total: 1,
    columnCounts: { inbox: 1 },
    doneLoaded: false,
  };
}

test("serves the shared board UI and protects browser operations with a per-process token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-web-"));
  const uiPath = join(directory, "board.html");
  await writeFile(
    uiPath,
    '<!doctype html><script id="boardBootstrap" type="application/json">__CODEX_BOARD_BOOTSTRAP__</script><script>(() => {})();</script>',
  );

  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "get_fast_snapshot") return { structuredContent: snapshot() };
    return { structuredContent: { ok: true, name, args } };
  };
  const server = createBoardWebServer({ callTool, uiPath, token: "test-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, service: "codex-conversation-board-web" });

    const pageResponse = await fetch(origin);
    const html = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /window\.__CODEX_BOARD_WEB__/);
    assert.match(html, /网页看板测试/);
    assert.doesNotMatch(html, /__CODEX_BOARD_BOOTSTRAP__/);
    assert.doesNotMatch(html, />test-token</);

    const blocked = await fetch(`${origin}/api/tools/move_thread`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, status: "doing" }),
    });
    assert.equal(blocked.status, 403);

    const moved = await fetch(`${origin}/api/tools/move_thread`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-board-token": "test-token",
      },
      body: JSON.stringify({ threadId: THREAD_ID, status: "doing" }),
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), {
      structuredContent: {
        ok: true,
        name: "move_thread",
        args: { threadId: THREAD_ID, status: "doing" },
      },
    });
    assert.deepEqual(calls.at(-1), {
      name: "move_thread",
      args: { threadId: THREAD_ID, status: "doing" },
    });

    const privateTool = await fetch(`${origin}/api/tools/show_board`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-board-token": "test-token",
      },
      body: "{}",
    });
    assert.equal(privateTool.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
