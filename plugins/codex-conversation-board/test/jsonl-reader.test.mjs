import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { readJsonLines } from "../server/jsonl-reader.js";

async function collectLines(chunks) {
  const input = Readable.from(chunks);
  const lines = [];
  readJsonLines(input, (line) => lines.push(line));
  await once(input, "end");
  return lines;
}

test("keeps U+2028 and U+2029 inside a JSONL message", async () => {
  const payload = JSON.stringify({
    title: "first\u2028second",
    preview: "first\u2029second",
  });

  assert.deepEqual(await collectLines([Buffer.from(`${payload}\n`, "utf8")]), [payload]);
});

test("preserves UTF-8 characters split across byte chunks", async () => {
  const payload = JSON.stringify({ title: "雪豹🦊" });
  const bytes = Buffer.from(`${payload}\n`, "utf8");
  const emojiStart = bytes.indexOf(Buffer.from("🦊", "utf8"));

  assert.deepEqual(await collectLines([
    bytes.subarray(0, emojiStart + 1),
    bytes.subarray(emojiStart + 1, emojiStart + 3),
    bytes.subarray(emojiStart + 3),
  ]), [payload]);
});

test("emits multiple LF-delimited messages", async () => {
  assert.deepEqual(
    await collectLines([Buffer.from('{"id":1}\n{"id":2}\n', "utf8")]),
    ['{"id":1}', '{"id":2}'],
  );
});

test("accepts CRLF and a final message without LF", async () => {
  assert.deepEqual(
    await collectLines([Buffer.from('{"id":1}\r\n{"id":2}', "utf8")]),
    ['{"id":1}', '{"id":2}'],
  );
});

test("keeps a large JSON response intact", async () => {
  const payload = JSON.stringify({ data: `${"x".repeat(1024 * 1024)}\u2028end` });
  const bytes = Buffer.from(`${payload}\n`, "utf8");
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8191) {
    chunks.push(bytes.subarray(offset, offset + 8191));
  }

  assert.deepEqual(await collectLines(chunks), [payload]);
});
