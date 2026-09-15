import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("source tabs keep the same horizontal position when the subtitle changes", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1188, height: 800 } });
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    const tabs = page.locator(".source-tabs");
    const positions = {};

    for (const source of ["codex", "chatgpt", "claude"]) {
      await page.locator(`.source-tab[data-source="${source}"]`).click();
      await page.waitForFunction((expected) => document.body.dataset.boardSource === expected, source);
      positions[source] = (await tabs.boundingBox())?.x;
      const subtitleFits = await page.locator("#brandSubtitle").evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      );
      assert.equal(subtitleFits, true, `${source} subtitle should fit at the desktop viewport`);
    }

    assert.equal(typeof positions.codex, "number");
    assert.equal(positions.chatgpt, positions.codex);
    assert.equal(positions.claude, positions.codex);
  } finally {
    await browser.close();
  }
});
