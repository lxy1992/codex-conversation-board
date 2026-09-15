import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-today-done-harness/index.html";

test("completed lane shows today's cards before loading its full history", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
    env: { ...process.env, CODEX_BOARD_TODAY_DONE: "1" },
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await assert.doesNotReject(() =>
      page.locator('.cards[data-status="done"] .card').waitFor({ timeout: 1_000 }),
    );
    assert.equal(await page.locator('.cards[data-status="done"] .card').count(), 1);
    assert.equal(
      await page.locator('.column:has(.cards[data-status="done"]) .count').textContent(),
      "3",
    );
    assert.match(
      await page.locator('.cards[data-status="done"] .lazy-done p').textContent(),
      /今天完成 1 个；另有 2 个历史已完成对话暂未加载/,
    );
    assert.match(
      await page.locator('.cards[data-status="done"] .lazy-done button').textContent(),
      /加载全部已完成（3）/,
    );

    await page.waitForTimeout(350);
    const inboxCard = page.locator('.cards[data-status="inbox"] .card').first();
    const newlyCompletedId = await inboxCard.getAttribute("data-thread-id");
    await inboxCard.locator(".card-move-button").click();
    await page.locator('#statusMenu [role="menuitem"]', { hasText: "完成" }).click();
    await assert.doesNotReject(() =>
      page.locator(
        `.cards[data-status="done"] .card[data-thread-id="${newlyCompletedId}"]`,
      ).waitFor({ timeout: 1_000 }),
    );
    assert.equal(await page.locator('.cards[data-status="done"] .card').count(), 2);
    assert.match(
      await page.locator('.cards[data-status="done"] .lazy-done p').textContent(),
      /今天完成 2 个；另有 2 个历史已完成对话暂未加载/,
    );
  } finally {
    await browser.close();
  }
});
