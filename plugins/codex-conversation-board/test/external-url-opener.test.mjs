import assert from "node:assert/strict";
import test from "node:test";

import { ExternalUrlOpener } from "../server/external-url-opener.js";

test("opens allow-listed app links without invoking a shell", async () => {
  const calls = [];
  const opener = new ExternalUrlOpener({
    platform: "darwin",
    execFileFn: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null);
    },
  });

  const result = await opener.open("claude://resume?session=22222222-2222-4222-8222-222222222222");
  assert.deepEqual(calls, [{
    file: "/usr/bin/open",
    args: ["claude://resume?session=22222222-2222-4222-8222-222222222222"],
    options: { timeout: 5_000 },
  }]);
  assert.equal(result.navigation, "external-deep-link");
});

test("rejects web and malformed URLs", async () => {
  const opener = new ExternalUrlOpener({
    execFileFn: () => assert.fail("must not execute"),
  });
  await assert.rejects(() => opener.open("https://example.com"), /不允许打开/);
  await assert.rejects(() => opener.open("not a url"), /无效的应用链接/);
});
