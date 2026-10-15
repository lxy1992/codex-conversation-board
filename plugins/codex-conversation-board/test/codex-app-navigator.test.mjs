import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAppNavigator,
  codexAppNavigatorInternals,
} from "../server/codex-app-navigator.js";
import {
  NativeNavigationBroker,
  requestBrokerReadState,
} from "../server/native-navigation-broker.js";

const CALLER_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_THREAD_ID = "22222222-2222-4222-8222-222222222222";

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

test("opens a ChatGPT conversation and updates read state through Codex native tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-native-nav-"));
  const pipePath = join(directory, "app-tools.sock");
  const received = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (pending.length < length + 4) return;
        const request = JSON.parse(pending.subarray(4, length + 4).toString("utf8"));
        pending = pending.subarray(length + 4);
        received.push(request);
        if (request.method === "tools/list") {
          socket.write(encodeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: ["navigate_to_codex_page", "set_thread_read_state"].map((name) => ({
                name,
                namespace: "codex_app",
                inputSchema: { type: "object" },
              })),
            },
          }));
        } else if (request.method === "tools/call") {
          socket.write(encodeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              contentItems: [{ type: "inputText", text: '{"navigated":true}' }],
              success: true,
            },
          }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });

  const navigator = new CodexAppNavigator({
    pipePath,
    interactionThreadId: CALLER_THREAD_ID,
    requestTimeoutMs: 1_000,
  });
  try {
    const result = await navigator.navigateToThread(CHAT_THREAD_ID, { requestId: "test-request" });
    assert.deepEqual(result, { navigated: true, navigation: "codex-app" });
    assert.equal(received[0].method, "tools/list");
    assert.deepEqual(received[1].params.arguments, { threadId: CHAT_THREAD_ID });
    assert.equal(received[1].params.threadId, CALLER_THREAD_ID);
    assert.equal(received[1].params.namespace, "codex_app");
    assert.equal(received[1].params.tool, "navigate_to_codex_page");

    assert.deepEqual(
      await navigator.setThreadReadState(CHAT_THREAD_ID, true, { requestId: "read-request" }),
      { readUpdated: true, read: true, readState: "codex-app" },
    );
    assert.equal(received[2].method, "tools/list");
    assert.deepEqual(received[3].params.arguments, {
      threadId: CHAT_THREAD_ID,
      read: true,
      source: "codex",
    });
    assert.equal(received[3].params.tool, "set_thread_read_state");
  } finally {
    await navigator.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("prefers the executor thread metadata for native navigation", () => {
  assert.equal(
    codexAppNavigatorInternals.executorThreadId({
      "x-codex-turn-metadata": JSON.stringify({ thread_id: CALLER_THREAD_ID }),
    }),
    CALLER_THREAD_ID,
  );
});

test("standalone web navigation is relayed through the Codex plugin process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-native-broker-"));
  const socketPath = join(directory, "native-navigation.sock");
  const navigated = [];
  const readUpdates = [];
  const broker = new NativeNavigationBroker({
    socketPath,
    navigator: {
      async navigateToThread(threadId) {
        navigated.push(threadId);
        return { navigated: true, navigation: "codex-app" };
      },
      async setThreadReadState(threadId, read) {
        readUpdates.push({ threadId, read });
        return { readUpdated: true, read, readState: "codex-app" };
      },
    },
  });
  await broker.start();
  const webNavigator = new CodexAppNavigator({
    useBroker: true,
    brokerPath: socketPath,
    requestTimeoutMs: 1_000,
  });
  try {
    assert.deepEqual(
      await webNavigator.navigateToThread(CHAT_THREAD_ID, { requestId: "web-test" }),
      { navigated: true, navigation: "codex-app" },
    );
    assert.deepEqual(navigated, [CHAT_THREAD_ID]);
    assert.deepEqual(
      await webNavigator.setThreadReadState(CHAT_THREAD_ID, true, { requestId: "web-read-test" }),
      { readUpdated: true, read: true, readState: "codex-app" },
    );
    assert.deepEqual(readUpdates, [{ threadId: CHAT_THREAD_ID, read: true }]);
  } finally {
    await webNavigator.close();
    await broker.close();
  }
});

test("read-state relay refuses an old broker instead of accidentally navigating", async () => {
  const requests = [];
  const oldBroker = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      requests.push(JSON.parse(chunk.trim()));
      Promise.resolve().then(() => socket.end(`${JSON.stringify({ ok: true })}\n`));
    });
  });
  await new Promise((resolveListen) => oldBroker.listen(0, "127.0.0.1", resolveListen));
  const brokerPort = oldBroker.address().port;
  try {
    let rejection;
    try {
      await requestBrokerReadState({ socketPath: brokerPort, threadId: CHAT_THREAD_ID, timeoutMs: 1_000 });
    } catch (error) {
      rejection = error;
    }
    assert.match(rejection?.message || "", /重启 Codex/);
    assert.deepEqual(requests, [{ health: true }]);
  } finally {
    await new Promise((resolveClose) => oldBroker.close(resolveClose));
  }
});
