import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("Claude tab follows ChatGPT, keeps separate state, and opens Claude Code", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    assert.deepEqual(
      await page.locator(".source-tab").allTextContents(),
      ["Codex", "ChatGPT", "Claude"],
    );

    await page.locator('.source-tab[data-source="claude"]').click();
    await page.waitForFunction(() => document.body.dataset.boardSource === "claude");
    await page.getByText("Claude 独立页签验收", { exact: true }).waitFor();

    assert.equal(await page.locator('.source-tab[data-source="claude"]').getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#activeMetric").isHidden(), true);
    assert.equal(await page.locator("#sourceHealth").textContent(), "数据源：Desktop 1 · CLI 1");
    assert.equal(await page.locator(".card").count(), 2);

    const firstCard = page.locator(".card").filter({ hasText: "Claude 独立页签验收" });
    await firstCard.locator(".card-move-button").click();
    await page.locator('#statusMenu button[data-status="done"]').click();
    await page.waitForFunction(() => window.__CODEX_BOARD_CALLS__.some(
      (call) => call.name === "move_thread" && call.args.source === "claude" && call.args.status === "done",
    ));

    const openLink = firstCard.locator(".card-open-button");
    assert.equal(await openLink.evaluate((node) => node.tagName), "A");
    assert.equal(
      await openLink.getAttribute("href"),
      "claude://code/continue?session=local_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    await openLink.click();
    await page.waitForFunction(() => document.body.dataset.openedThread?.startsWith("claude://"));
    assert.equal(
      await page.locator("body").getAttribute("data-opened-thread"),
      "claude://code/continue?session=local_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
  } finally {
    await browser.close();
  }
});

test("Claude tab automatically loads a modest completed-only board instead of looking empty", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });

  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await page.locator('.source-tab[data-source="claude"]').click();
    await page.waitForFunction(() => document.body.dataset.boardSource === "claude");
    await page.evaluate(() => {
      window.__CODEX_BOARD_CALLS__.length = 0;
      window.__CODEX_BOARD_APPLY_DATA__({
        ...structuredClone(window.__CODEX_BOARD_CLAUDE_SNAPSHOT__),
        projects: [],
        threads: [],
        total: 61,
        columnCounts: {
          inbox: 0,
          todo: 0,
          doing: 0,
          blocked: 0,
          review: 0,
          done: 61,
        },
        doneLoaded: false,
        donePreviewCount: 0,
      });
    });

    await page.waitForFunction(() => window.__CODEX_BOARD_CALLS__.some(
      (call) => call.name === "get_board" && call.args.source === "claude" && call.args.includeDone === true,
    ), null, { timeout: 1_000 });
    await page.locator(".card").first().waitFor({ state: "visible", timeout: 1_000 });
  } finally {
    await browser.close();
  }
});
