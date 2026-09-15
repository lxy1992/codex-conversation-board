import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("a renamed conversation updates on the existing lightweight refresh", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    const card = page.locator('.card:not([data-status="done"])').first();
    const threadId = await card.getAttribute("data-thread-id");
    const originalTitle = await card.locator(".card-open-button").textContent();
    const renamedTitle = "已重命名的演示对话";
    assert.notEqual(originalTitle, renamedTitle);

    await page.evaluate(async ({ threadId, renamedTitle }) => {
      window.__CODEX_BOARD_TITLE_OVERRIDES__[threadId] = renamedTitle;
      await window.__CODEX_BOARD_REFRESH_ACTIVITIES__();
    }, { threadId, renamedTitle });

    assert.equal(await card.locator(".card-open-button").textContent(), renamedTitle);
  } finally {
    await browser.close();
  }
});
