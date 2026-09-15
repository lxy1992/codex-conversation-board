import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("ChatGPT tab is separate, movable, and opens the selected chat inside Codex", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await page.locator('.source-tab[data-source="chatgpt"]').click();
    await page.waitForFunction(() => document.body.dataset.boardSource === "chatgpt");
    await page.getByText("ChatGPT 独立页签验收", { exact: true }).waitFor();

    assert.equal(await page.locator('.source-tab[data-source="chatgpt"]').getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#activeMetric").isHidden(), true);
    assert.equal(await page.locator(".card").count(), 2);

    const firstCard = page.locator(".card").filter({ hasText: "ChatGPT 独立页签验收" });
    await firstCard.locator(".card-move-button").click();
    await page.evaluate(() => {
      window.__CODEX_BOARD_APPLY_DATA__(structuredClone(window.__CODEX_BOARD_CHATGPT_SNAPSHOT__));
    });
    await page.locator('#statusMenu button[data-status="done"]').waitFor();
    await page.locator('#statusMenu button[data-status="done"]').click();
    await page.waitForFunction(() => window.__CODEX_BOARD_CALLS__.some(
      (call) => call.name === "move_thread" && call.args.source === "chatgpt" && call.args.status === "done",
    ));

    const openButton = firstCard.locator(".card-open-button");
    assert.equal(await openButton.evaluate((node) => node.tagName), "BUTTON");
    assert.equal(await openButton.getAttribute("href"), null);
    await openButton.click();
    await page.waitForFunction(() => document.body.dataset.openedThread?.startsWith("codex-app://chat/"));
    assert.equal(
      await page.locator("body").getAttribute("data-opened-thread"),
      "codex-app://chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  } finally {
    await browser.close();
  }
});
