import assert from "node:assert/strict";
import test from "node:test";
import { isSameLocalDay, localDateKey, timestampMs } from "../server/time.js";

test("normalizes Codex timestamps without treating a missing completion time as today", () => {
  const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
  const yesterday = new Date(2026, 7, 30, 23, 59, 59).getTime();

  assert.equal(timestampMs(Math.floor(now / 1_000)), Math.floor(now / 1_000) * 1_000);
  assert.equal(localDateKey(now), "2026-08-31");
  assert.equal(isSameLocalDay(now, now), true);
  assert.equal(isSameLocalDay(yesterday, now), false);
  assert.equal(isSameLocalDay(undefined, now), false);
  assert.equal(isSameLocalDay(null, now), false);
});
