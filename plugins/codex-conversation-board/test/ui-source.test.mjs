import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("board UI exposes a per-card status menu and has valid inline JavaScript", async () => {
  const html = await readFile(resolve(ROOT, "ui/board.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
  assert.match(html, /className = "card-move-button"/);
  assert.match(html, /id="statusMenu"[^>]*role="menu"/);
  assert.match(html, /option\.setAttribute\("role", "menuitem"\)/);
  assert.match(html, /callTool\("move_thread", \{/);
  assert.match(html, /source: state\.source,[\s\S]*threadId: thread\.id,[\s\S]*beforeThreadId/);
  assert.match(html, /function makeLazyDone\(\)/);
  assert.match(html, /includeDone: true/);
  assert.match(html, /id="boardBootstrap"/);
  assert.match(html, /function bootstrapBoard\(\)/);
  assert.match(html, /function normalizeBoardSnapshot\(value, expectedSource = state\.source\)/);
  assert.match(html, /activitySourceVersion: hasCurrentActivities \? ACTIVITY_SOURCE_VERSION : 0/);
  assert.match(html, /window\.openai\?\.toolOutput/);
  assert.match(html, /window\.__CODEX_BOARD_WEB__\.callTool\(name, args\)/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /postMessageRequest\(\s*"ui\/initialize"/);
  assert.match(html, /postMessageNotification\("ui\/notifications\/initialized"\)/);
  assert.match(html, /openButton\.href = thread\.openUrl/);
  assert.match(html, /openButton\.addEventListener\("click"/);
  assert.match(html, /className = "activity"/);
  assert.match(html, /get_thread_activity/);
  assert.match(html, /result\.reopenedThreadIds/);
  assert.match(html, /新回复未读/);
  assert.match(html, /data-source="codex"/);
  assert.match(html, /data-source="chatgpt"/);
  assert.match(html, /data-source="claude"/);
  assert.match(html, /Claude Code 会话/);
  assert.match(html, /async function switchSource\(source\)/);
  assert.match(html, /callTool\("get_fast_snapshot", \{ source \}\)/);
  assert.match(html, /CARD_RENDER_LIMIT = 120/);
  assert.match(html, /function makeLazyColumn\(columnId, hiddenCount\)/);
  assert.match(html, /id="settingsButton"/);
  assert.match(html, /id="columnSettingsDialog"[^>]*role="dialog"/);
  assert.match(html, /callTool\("update_board_columns", \{/);

  const openThreadSource = html.slice(
    html.indexOf("async function openThread"),
    html.indexOf("function applyBoardData"),
  );
  const navigationToolIndex = openThreadSource.indexOf('callTool("open_thread"');
  const deepLinkFallbackIndex = openThreadSource.indexOf("link.href = url");
  assert.ok(navigationToolIndex >= 0 && navigationToolIndex < deepLinkFallbackIndex);
});
