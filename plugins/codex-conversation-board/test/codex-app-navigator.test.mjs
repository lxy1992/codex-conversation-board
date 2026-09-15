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
import { NativeNavigationBroker } from "../server/native-navigation-broker.js";

const CALLER_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_THREAD_ID = "22222222-2222-4222-8222-222222222222";

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

test("opens a ChatGPT conversation through Codex native app navigation", async () => {
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
              tools: [{
                name: "navigate_to_codex_page",
                namespace: "codex_app",
                description: "Navigate to a task or chat",
                inputSchema: { type: "object" },
              }],
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
  const broker = new NativeNavigationBroker({
    socketPath,
    navigator: {
      async navigateToThread(threadId) {
        navigated.push(threadId);
        return { navigated: true, navigation: "codex-app" };
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
  } finally {
    await webNavigator.close();
    await broker.close();
  }
});
