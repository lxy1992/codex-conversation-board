import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadBrowserRuntime } from "./browser-test-runtime.mjs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const HARNESS_PATH = "/private/tmp/codex-board-ui-harness/index.html";

test("users can add, rename, remove, and reorder board statuses", async (t) => {
  await execFileAsync(process.execPath, [new URL("test/build-ui-harness.mjs", ROOT).pathname], {
    cwd: ROOT.pathname,
  });
  const runtime = await loadBrowserRuntime(t);
  if (!runtime) return;
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1188, height: 800 } });
    await page.goto(pathToFileURL(HARNESS_PATH).href);
    await page.locator("#settingsButton").click();
    await page.locator("#columnSettingsDialog").waitFor({ state: "visible" });

    assert.equal(await page.locator(".settings-column-row").count(), 6);
    assert.equal(
      await page.locator('.settings-column-row[data-column-id="inbox"] [data-action="delete"]').isDisabled(),
      true,
    );
    assert.equal(
      await page.locator('.settings-column-row[data-column-id="done"] [data-action="delete"]').isDisabled(),
      true,
    );

    await page.locator('.settings-column-row[data-column-id="done"] .settings-label').fill("已归档");
    await page.locator("#addColumnButton").click();
    const customRow = page.locator('.settings-column-row[data-column-id^="custom-"]');
    await customRow.locator(".settings-label").fill("等待发布");
    await customRow.locator(".settings-description").fill("等待上线");
    await customRow.locator('[data-action="up"]').click();

    await page.locator('.settings-column-row[data-column-id="todo"] [data-action="delete"]').click();
    await page.locator("#settingsMigration").waitFor({ state: "visible" });
    assert.match(await page.locator("#settingsMigrationText").textContent(), /3 个对话/);
    await page.locator("#settingsMigrationTarget").selectOption("doing");
    await page.locator("#settingsSaveButton").click();
    await page.locator("#columnSettingsDialog").waitFor({ state: "hidden" });

    const updateCall = await page.evaluate(() => (
      window.__CODEX_BOARD_CALLS__.findLast((call) => call.name === "update_board_columns")
    ));
    assert.deepEqual(updateCall.args.columns.map(({ id }) => id), [
      "inbox",
      "doing",
      "blocked",
      "review",
      updateCall.args.columns.find(({ id }) => id.startsWith("custom-"))?.id,
      "done",
    ]);
    assert.equal(updateCall.args.columns.at(-1).label, "已归档");
    assert.equal(updateCall.args.migrationTarget, "doing");
    assert.deepEqual(
      await page.locator(".column-title").allTextContents(),
      ["收件箱", "进行中", "阻塞", "待验收", "等待发布", "已归档"],
    );
    assert.equal(await page.locator('.cards[data-status="doing"] .card').count(), 6);
  } finally {
    await browser.close();
  }
});
