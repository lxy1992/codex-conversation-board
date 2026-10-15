import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("card quick action moves to the configured target and clears unread state", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });
  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1188, height: 800 } });
    await page.goto(pathToFileURL(HARNESS_PATH).href);

    const unreadCard = page.locator('.cards[data-status="todo"] .card:has(.activity[data-state="unread"])');
    const unreadId = await unreadCard.getAttribute("data-thread-id");
    await unreadCard.locator(".card-quick-button").click();
    await page.waitForFunction((threadId) => (
      window.__CODEX_BOARD_CALLS__.some((call) => (
        call.name === "quick_move_thread" && call.args.threadId === threadId
      ))
    ), unreadId);

    assert.equal(await page.locator(`.cards[data-status="done"] .card[data-thread-id="${unreadId}"]`).count(), 1);
    assert.equal(await page.locator(`.card[data-thread-id="${unreadId}"] .activity[data-state="unread"]`).count(), 0);
    assert.deepEqual(
      await page.evaluate((threadId) => window.__CODEX_BOARD_CALLS__.findLast((call) => (
        call.name === "quick_move_thread" && call.args.threadId === threadId
      )).args, unreadId),
      { source: "codex", threadId: unreadId },
    );

    await page.locator("#settingsButton").click();
    await page.locator("#settingsQuickMoveTarget").selectOption("review");
    await page.locator("#settingsSaveButton").click();
    await page.locator("#columnSettingsDialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => window.__CODEX_BOARD_CALLS__.findLast(
        (call) => call.name === "update_board_columns",
      ).args.quickMoveTarget),
      "review",
    );

    const inboxCard = page.locator('.cards[data-status="inbox"] .card').first();
    const inboxId = await inboxCard.getAttribute("data-thread-id");
    assert.match(await inboxCard.locator(".card-quick-button").textContent(), /待验收/);
    await inboxCard.locator(".card-quick-button").click();
    await page.waitForFunction((threadId) => (
      window.__CODEX_BOARD_CALLS__.some((call) => (
        call.name === "quick_move_thread" && call.args.threadId === threadId
      ))
    ), inboxId);
    assert.equal(await page.locator(`.cards[data-status="review"] .card[data-thread-id="${inboxId}"]`).count(), 1);
  } finally {
    await browser.close();
  }
});
