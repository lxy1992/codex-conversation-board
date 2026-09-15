import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-mcp-app-host/index.html";

test("title click initializes the MCP App before calling open_thread", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-mcp-app-host-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    const app = page.frameLocator("#app");
    const title = app.locator(".card-open-button").first();
    await title.waitFor({ state: "visible" });
    await title.click();

    await assert.doesNotReject(() =>
      page.waitForFunction(() => document.body.dataset.openedThread, null, { timeout: 1_000 }),
    );
    const navigationSequence = async () => (await page.locator("body").getAttribute("data-sequence"))
      .split(",")
      .filter((entry) => ![
        "tools/call:get_thread_activity",
        "tools/call:get_board",
      ].includes(entry))
      .join(",");
    assert.equal(
      await navigationSequence(),
      "ui/initialize,ui/notifications/initialized,tools/call:open_thread",
    );

    await page.evaluate(() => {
      delete document.body.dataset.openedThread;
    });
    await app.locator(".card-meta").first().click();
    await assert.doesNotReject(() =>
      page.waitForFunction(() => document.body.dataset.openedThread, null, { timeout: 1_000 }),
    );
    assert.equal(
      await navigationSequence(),
      "ui/initialize,ui/notifications/initialized,tools/call:open_thread,tools/call:open_thread",
    );
  } finally {
    await browser.close();
  }
});

test("card uses the synchronous host deep link when the MCP tool bridge stalls", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-mcp-app-host-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await page.evaluate(() => {
      window.__DROP_OPEN_THREAD__ = true;
      delete document.body.dataset.openedThread;
    });
    const app = page.frameLocator("#app");
    const cardBody = app.locator(".card-meta").first();
    await cardBody.waitFor({ state: "visible" });
    await cardBody.click({ noWaitAfter: true });

    await assert.doesNotReject(() =>
      page.waitForFunction(() => document.body.dataset.openExternal, null, { timeout: 500 }),
    );
    assert.match(
      await page.locator("body").getAttribute("data-open-external"),
      /^codex:\/\/threads\//,
    );
    assert.equal(await page.locator("body").getAttribute("data-open-external-active"), "true");
  } finally {
    await browser.close();
  }
});
