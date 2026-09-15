import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("cards distinguish active conversations and unread returned replies", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);

    await assert.doesNotReject(() => page.locator('.activity[data-state="active"]').first().waitFor());
    assert.equal(await page.locator('.activity[data-state="active"]').first().textContent(), "对话中");
    assert.equal(await page.locator('.activity[data-state="unread"]').first().textContent(), "新回复未读");

    const activeCard = page.locator('.card:has(.activity[data-state="active"])').first();
    const activeThreadId = await activeCard.getAttribute("data-thread-id");
    await page.evaluate(async ({ threadId }) => {
      window.__CODEX_BOARD_ACTIVITY_OVERRIDES__[threadId] = {
        state: "unread",
        label: "新回复未读",
        unread: true,
        startedAt: "2026-08-28T02:00:00.000Z",
        completedAt: "2026-08-28T03:00:00.000Z",
      };
      await window.__CODEX_BOARD_REFRESH_ACTIVITIES__();
    }, { threadId: activeThreadId });
    assert.equal(
      await page.locator(`.card[data-thread-id="${activeThreadId}"] .activity`).textContent(),
      "新回复未读",
    );
    assert.equal(
      await page.locator(`.card[data-thread-id="${activeThreadId}"]`).getAttribute("data-activity"),
      "unread",
    );

    // A still-running 0.2.1 host can return the old inferred activity shape.
    // The embedded/native-v2 status must not be overwritten while the tab hot-reloads.
    await assert.doesNotReject(
      page.evaluate(({ threadId }) => {
        const legacy = structuredClone(window.__CODEX_BOARD_SNAPSHOT__);
        legacy.generatedAt = "2099-01-01T00:00:00.000Z";
        delete legacy.activitySourceVersion;
        legacy.threads = legacy.threads.map((thread) => thread.id === threadId
          ? { ...thread, activity: { state: "active", label: "对话中", unread: false } }
          : thread);
        window.__CODEX_BOARD_APPLY_DATA__(legacy, { persist: false });
      }, { threadId: activeThreadId }),
    );
    assert.equal(
      await page.locator(`.card[data-thread-id="${activeThreadId}"]`).getAttribute("data-activity"),
      "unread",
    );

    const unreadCard = page.locator('.card:has(.activity[data-state="unread"])').first();
    const threadId = await unreadCard.getAttribute("data-thread-id");
    await page.evaluate(() => {
      window.__TEST_NOW__ = Date.now();
      Date.now = () => window.__TEST_NOW__;
    });
    await unreadCard.locator(".card-open-button").click();
    await page.waitForFunction(
      (id) => document.body.dataset.openedThread?.includes(id),
      threadId,
      { timeout: 1_000 },
    );
    await assert.doesNotReject(() =>
      page.locator(`.card[data-thread-id="${threadId}"] .activity[data-state="unread"]`).waitFor({
        state: "detached",
        timeout: 1_000,
      }),
    );
    await page.evaluate(async () => {
      window.__TEST_NOW__ += 6_000;
      await window.__CODEX_BOARD_REFRESH_ACTIVITIES__();
    });
    await assert.doesNotReject(() =>
      page.locator(`.card[data-thread-id="${threadId}"] .activity[data-state="unread"]`).waitFor({
        state: "detached",
        timeout: 1_000,
      }),
    );

    const doneCard = page.locator('.cards[data-status="done"] .card').first();
    const reopenedThreadId = await doneCard.getAttribute("data-thread-id");
    await page.evaluate(async ({ reopenedThreadId }) => {
      const nextSnapshot = structuredClone(window.__CODEX_BOARD_SNAPSHOT__);
      nextSnapshot.generatedAt = new Date().toISOString();
      nextSnapshot.threads = nextSnapshot.threads.map((thread) => thread.id === reopenedThreadId
        ? { ...thread, boardStatus: "inbox", boardPosition: 0 }
        : thread);
      nextSnapshot.columnCounts.done -= 1;
      nextSnapshot.columnCounts.inbox += 1;
      window.__CODEX_BOARD_SNAPSHOT__ = nextSnapshot;
      window.__CODEX_BOARD_REOPENED_IDS__ = [reopenedThreadId];
      await window.__CODEX_BOARD_REFRESH_ACTIVITIES__();
    }, { reopenedThreadId });
    await assert.doesNotReject(() =>
      page.locator(`.cards[data-status="inbox"] .card[data-thread-id="${reopenedThreadId}"]`).waitFor({
        timeout: 1_000,
      }),
    );
    assert.match(await page.locator("#status").textContent(), /1 个已完成对话因新回复移回收件箱/);
  } finally {
    await browser.close();
  }
});
