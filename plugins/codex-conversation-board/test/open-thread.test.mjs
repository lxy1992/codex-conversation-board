import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("card click uses the MCP navigation tool when host openExternal is a no-op", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    const firstCard = page.locator(".card-open-button").first();
    await firstCard.waitFor({ state: "visible" });
    await firstCard.click();

    await assert.doesNotReject(() =>
      page.waitForFunction(() => document.body.dataset.openedThread, null, { timeout: 1_000 }),
    );
    assert.match(await page.locator("body").getAttribute("data-opened-thread"), /^codex:\/\/threads\//);
  } finally {
    await browser.close();
  }
});
