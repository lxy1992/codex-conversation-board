import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-stale-widget-harness/index.html";

test("a legacy host snapshot renders the board instead of the incomplete-data error", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
    env: {
      ...process.env,
      CODEX_BOARD_STALE_WIDGET: "1",
      CODEX_BOARD_LEGACY_TOOL: "1",
    },
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await assert.doesNotReject(() => page.locator(".card").first().waitFor({ timeout: 750 }));
    assert.equal(await page.locator(".error-panel").count(), 0);
    await assert.doesNotReject(() =>
      page.locator('.activity[data-state="active"]').first().waitFor({ timeout: 3_000 }),
    );
    assert.equal(await page.locator('.activity[data-state="active"]').first().textContent(), "对话中");
    assert.equal(await page.locator('.activity[data-state="unread"]').first().textContent(), "新回复未读");
  } finally {
    await browser.close();
  }
});
