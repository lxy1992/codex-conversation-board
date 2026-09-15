import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readNativeUnreadThreadIds } from "../server/native-thread-state.js";

const LOCAL_UNREAD = "11111111-1111-4111-8111-111111111111";
const REMOTE_UNREAD = "22222222-2222-4222-8222-222222222222";

test("reads the same persisted unread set used by the Codex native sidebar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-state-"));
  const filePath = join(directory, "global-state.json");
  await writeFile(filePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": {
        local: [LOCAL_UNREAD, 42, null],
        "remote-control:test": [REMOTE_UNREAD],
      },
    },
  }));

  assert.deepEqual(
    [...await readNativeUnreadThreadIds({ filePath })],
    [LOCAL_UNREAD],
  );
  assert.deepEqual(
    [...await readNativeUnreadThreadIds({ filePath, hostId: "remote-control:test" })],
    [REMOTE_UNREAD],
  );
});

test("reads the current identity-scoped unread set used by Codex 26.903", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-state-current-"));
  const filePath = join(directory, "global-state.json");
  await writeFile(filePath, JSON.stringify({
    "electron-thread-read-state-v1": {
      version: 1,
      unreadByIdentity: {
        "identity-a": {
          "local:host-key-a": [LOCAL_UNREAD, 42, null],
        },
        "identity-b": {
          "remote:host-key-b": [REMOTE_UNREAD],
        },
      },
    },
  }));

  assert.deepEqual(
    [...await readNativeUnreadThreadIds({ filePath })],
    [LOCAL_UNREAD, REMOTE_UNREAD],
  );
});
