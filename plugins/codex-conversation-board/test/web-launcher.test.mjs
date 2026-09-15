import assert from "node:assert/strict";
import test from "node:test";

import { ensureWebBoardReady } from "../server/web-launcher.js";

test("one-click launcher opens an already-running board without starting another server", async () => {
  let starts = 0;
  let opens = 0;

  await ensureWebBoardReady({
    checkReady: async () => true,
    startServer: () => { starts += 1; },
    openBoard: async () => { opens += 1; },
    sleep: async () => {},
  });

  assert.equal(starts, 0);
  assert.equal(opens, 1);
});

test("one-click launcher starts the board in the background and opens it when ready", async () => {
  const checks = [false, false, true];
  let starts = 0;
  let opens = 0;

  await ensureWebBoardReady({
    checkReady: async () => checks.shift() ?? true,
    startServer: () => { starts += 1; },
    openBoard: async () => { opens += 1; },
    sleep: async () => {},
    maxAttempts: 5,
  });

  assert.equal(starts, 1);
  assert.equal(opens, 1);
});

test("one-click launcher reports a useful error when the board never starts", async () => {
  await assert.rejects(
    ensureWebBoardReady({
      checkReady: async () => false,
      startServer: () => {},
      openBoard: async () => assert.fail("must not open an unavailable board"),
      sleep: async () => {},
      maxAttempts: 2,
      logPath: "/tmp/codex-board-test.log",
    }),
    /codex-board-test\.log/,
  );
});
