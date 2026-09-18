import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";
const NEW_ID = "99999999-1111-4111-8111-111111111111";
const FOCUSED_ID = "88888888-1111-4111-8111-111111111111";

test("a conversation created after opening appears without manual refresh", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });
  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await page.locator('.card[data-thread-id="00000001-1111-4111-8111-111111111111"]').waitFor();
    await page.waitForTimeout(400); // Let the initial silent get_board complete.
    assert.equal(await page.evaluate(async () => {
      const card = document.querySelector('.card[data-thread-id="00000001-1111-4111-8111-111111111111"]');
      await window.__CODEX_BOARD_REFRESH_BOARD__();
      return card === document.querySelector('.card[data-thread-id="00000001-1111-4111-8111-111111111111"]');
    }), true, "an unchanged background refresh should not redraw cards");

    await page.evaluate(async (newId) => {
      const next = {
        ...structuredClone(window.__CODEX_BOARD_THREADS__[0]),
        id: newId,
        title: "刚创建的新对话",
        boardStatus: "inbox",
        boardPosition: 99,
        updatedAt: Date.now(),
      };
      window.__CODEX_BOARD_THREADS__.push(next);
      window.__CODEX_BOARD_SNAPSHOT__.threads.push(next);
      window.__CODEX_BOARD_SNAPSHOT__.total += 1;
      window.__CODEX_BOARD_SNAPSHOT__.columnCounts.inbox += 1;
      await window.__CODEX_BOARD_REFRESH_BOARD__();
    }, NEW_ID);

    const automaticCount = await page.locator(`.card[data-thread-id="${NEW_ID}"]`).count();
    await page.locator("#refreshButton").click();
    assert.equal(await page.locator(`.card[data-thread-id="${NEW_ID}"]`).count(), 1,
      "manual refresh should load the fixture's new conversation");
    assert.equal(
      automaticCount,
      1,
      "automatic refresh should add a new card without clicking Refresh",
    );

    await page.evaluate((newId) => {
      const next = {
        ...structuredClone(window.__CODEX_BOARD_THREADS__[0]),
        id: newId,
        title: "回来后出现的新对话",
        boardStatus: "inbox",
        boardPosition: 100,
        updatedAt: Date.now(),
      };
      window.__CODEX_BOARD_THREADS__.push(next);
      window.__CODEX_BOARD_SNAPSHOT__.threads.push(next);
      window.__CODEX_BOARD_SNAPSHOT__.total += 1;
      window.__CODEX_BOARD_SNAPSHOT__.columnCounts.inbox += 1;
      const actualNow = Date.now;
      Date.now = () => actualNow() + 6_000;
      window.dispatchEvent(new Event("focus"));
      Date.now = actualNow;
    }, FOCUSED_ID);
    await page.locator(`.card[data-thread-id="${FOCUSED_ID}"]`).waitFor({ timeout: 3_000 });
  } finally {
    await browser.close();
  }
});
