import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createJsonlReader } from "../server/jsonl-reader.js";

const TEXT = "first\u2028second\u2029中文😀e\u0301";
const MESSAGE = JSON.stringify({ id: 1, result: { title: TEXT, preview: TEXT } });

async function readLines(chunks, { encoding } = {}) {
  const input = Readable.from(chunks);
  if (encoding) input.setEncoding(encoding);
  const reader = createJsonlReader({ input });
  const lines = [];
  reader.on("line", (line) => lines.push(line));
  await once(reader, "close");
  return lines;
}

test("U+2028 and U+2029 remain inside one JSON protocol message", async () => {
  const lines = await readLines([Buffer.from(`${MESSAGE}\n`)]);
  assert.deepEqual(lines, [MESSAGE]);
  assert.equal(JSON.parse(lines[0]).result.title, TEXT);
  assert.equal(JSON.parse(lines[0]).result.preview, TEXT);
});

test("UTF-8 survives every two-chunk boundary and one-byte chunks", async () => {
  const bytes = Buffer.from(`${MESSAGE}\n`);
  for (let split = 0; split <= bytes.length; split++) {
    assert.deepEqual(await readLines([bytes.subarray(0, split), bytes.subarray(split)]), [MESSAGE],
      `split at byte ${split}`);
  }
  assert.deepEqual(await readLines(Array.from(bytes, (byte) => Buffer.from([byte]))), [MESSAGE]);
});

test("multiple messages work in a single chunk and arbitrary chunks", async () => {
  const expected = [MESSAGE, '{"id":2}', '{"id":3}'];
  const bytes = Buffer.from(expected.join("\n") + "\n");
  assert.deepEqual(await readLines([bytes]), expected);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
  assert.deepEqual(await readLines(chunks), expected);
});

test("CRLF can cross chunks; bare CR never creates a record", async () => {
  assert.deepEqual(await readLines([Buffer.from(`${MESSAGE}\r`), Buffer.from('\n{"id":2}\r'), Buffer.from("\n")]),
    [MESSAGE, '{"id":2}']);
  assert.deepEqual(await readLines([Buffer.from('{"id":1}\r{"id":2}\n')]), ['{"id":1}\r{"id":2}']);
  assert.deepEqual(await readLines([JSON.stringify({ text: "escaped\r\nnewline" }) + "\n"]),
    [JSON.stringify({ text: "escaped\r\nnewline" })]);
});

test("EOF emits the last record once without inventing a trailing empty record", async () => {
  for (const suffix of ["", "\n", "\r\n", "\r"]) {
    assert.deepEqual(await readLines([Buffer.from(MESSAGE + suffix)]), [MESSAGE]);
  }
  assert.deepEqual(await readLines([]), []);
  assert.deepEqual(await readLines([Buffer.alloc(0)]), []);
  assert.deepEqual(await readLines(["\n\r\n  \n"]), ["", "", "  "]);
});

test("already decoded UTF-8 streams and string chunks are supported", async () => {
  const bytes = Buffer.from(`${MESSAGE}\n`);
  assert.deepEqual(await readLines(Array.from(bytes, (byte) => Buffer.from([byte])), { encoding: "utf8" }), [MESSAGE]);
  assert.deepEqual(await readLines([MESSAGE, "\n"]), [MESSAGE]);
});

test("malformed JSON is kept in its own frame and a following message survives", async () => {
  const lines = await readLines([`synthetic-invalid\n{"unfinished":\n${MESSAGE}\n`]);
  assert.equal(lines.length, 3);
  for (const line of lines.slice(0, 2)) assert.throws(() => JSON.parse(line));
  assert.deepEqual(JSON.parse(lines[2]), JSON.parse(MESSAGE));
  assert.deepEqual(await readLines(['{"unfinished":']), ['{"unfinished":']);
});

test("invalid or truncated UTF-8 uses decoder replacement without losing frame boundaries", async () => {
  const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(`\n${MESSAGE}\n`), Buffer.from([0xe4, 0xb8])]);
  assert.deepEqual(await readLines([bytes]), ["\ufffd", MESSAGE, "\ufffd"]);
});

test("a large Unicode response spans many chunks without corrupting the next response", async () => {
  const message = JSON.stringify({ id: 1, result: { text: TEXT.repeat(32_768) } });
  const bytes = Buffer.from(`${message}\n${MESSAGE}\n`);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 4093) chunks.push(bytes.subarray(i, i + 4093));
  assert.deepEqual(await readLines(chunks), [message, MESSAGE]);
});

test("close detaches listeners and stops a batched read", () => {
  const input = new PassThrough();
  const reader = createJsonlReader({ input });
  const lines = [];
  let closes = 0;
  reader.on("close", () => { closes++; });
  reader.on("line", (line) => { lines.push(line); reader.close(); });
  input.write("first\nsecond\nunfinished");
  reader.close();
  input.end("later\n");
  assert.deepEqual(lines, ["first"]);
  assert.equal(closes, 1);
  for (const event of ["data", "end", "close", "error"]) assert.equal(input.listenerCount(event), 0);
});

test("manual close discards a partial record without destroying the shared input", () => {
  const input = new PassThrough();
  const reader = createJsonlReader({ input });
  const lines = [];
  reader.on("line", (line) => lines.push(line));
  input.write("partial");
  reader.close();
  assert.equal(input.destroyed, false);
  input.end("tail\n");
  assert.deepEqual(lines, []);
});

test("an aborted stream discards its partial record", async () => {
  const input = new PassThrough();
  const reader = createJsonlReader({ input });
  const lines = [];
  reader.on("line", (line) => lines.push(line));
  const closed = once(reader, "close");
  input.write("complete\npartial");
  input.destroy();
  await closed;
  assert.deepEqual(lines, ["complete"]);
});

test("input errors are forwarded without treating partial data as a message", async () => {
  const input = new PassThrough();
  const reader = createJsonlReader({ input });
  const lines = [];
  reader.on("line", (line) => lines.push(line));
  const failure = new Error("synthetic read failure");
  const closed = once(reader, "close");
  input.write("partial");
  input.destroy(failure);
  await assert.rejects(closed, failure);
  assert.deepEqual(lines, []);
  assert.equal(input.listenerCount("data"), 0);
});
