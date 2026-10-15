// Synthetic protocol peer. Deliberately independent of the production reader.
import { setImmediate } from "node:timers/promises";

const TEXT = "first\u2028second\u2029中文😀";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
let buffered = "";
let writes = Promise.resolve();

async function respond(message) {
  if (message.id === undefined) return;
  const action = message.method === "tools/call" ? message.params.name : message.method;
  if (action === "synthetic/invalid") {
    process.stdout.write('synthetic-invalid\nnull\n42\n[]\n');
  }
  if (action === "thread/list") {
    process.stdout.write(JSON.stringify({ method: "synthetic/event", params: { text: TEXT } }) + "\n");
  }
  const result = action === "initialize" ? {} : action === "thread/list"
    ? { data: [{ id: THREAD_ID, name: TEXT, preview: TEXT, status: { type: "idle" } }], nextCursor: null }
    : { text: TEXT, echo: message.params };
  const response = action === "synthetic/error"
    ? { id: message.id, error: { code: -32000, message: TEXT } }
    : { id: message.id, result };
  const bytes = Buffer.from(JSON.stringify(response) + (action === "synthetic/tail" ? "" : "\r\n"));
  for (let offset = 0; offset < bytes.length; offset += 7) {
    process.stdout.write(bytes.subarray(offset, offset + 7));
    await setImmediate();
  }
  if (action === "synthetic/tail") process.stdout.end();
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index;
  while ((index = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      writes = writes.then(() => respond(message));
    }
  }
});
process.stdin.on("end", () => {
  writes.then(() => process.stdout.end());
});
