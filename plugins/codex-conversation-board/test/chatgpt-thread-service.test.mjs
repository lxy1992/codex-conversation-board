import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ChatGptThreadService } from "../server/chatgpt-thread-service.js";

test("reads ChatGPT chats from the local catalog without loading message bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-chatgpt-catalog-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const globalStatePath = join(directory, "global-state.json");
  const database = new DatabaseSync(catalogPath);
  database.exec(`
    CREATE TABLE local_thread_catalog (
      host_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_title TEXT NOT NULL,
      source_created_at REAL NOT NULL,
      source_updated_at REAL NOT NULL,
      source_recency_at REAL NOT NULL,
      source_kind TEXT NOT NULL,
      project_id TEXT,
      missing_candidate INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(`
    INSERT INTO local_thread_catalog (
      host_id, thread_id, display_title, source_created_at, source_updated_at,
      source_recency_at, source_kind, project_id, missing_candidate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("chatgpt:account", "11111111-1111-4111-8111-111111111111", "项目 Chat", 10, 20, 20, "chatgpt", "g-p-personal", 0);
  insert.run("chatgpt:account", "22222222-2222-4222-8222-222222222222", "普通 Chat", 11, 18, 18, "chatgpt", null, 0);
  insert.run("local", "33333333-3333-4333-8333-333333333333", "Codex task", 12, 21, 21, "vscode", null, 0);
  insert.run("chatgpt:account", "44444444-4444-4444-8444-444444444444", "removed", 9, 9, 9, "chatgpt", null, 1);
  database.close();

  await writeFile(globalStatePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "chatgpt-sidebar-state-v1": {
        account: {
          projects: [{ id: "g-p-personal", name: "个人" }],
          pinnedProjects: [],
          pinnedConversations: [{
            conversation: { id: "11111111-1111-4111-8111-111111111111" },
          }],
        },
      },
    },
  }));

  const result = await new ChatGptThreadService({
    catalogPath,
    globalStatePath,
  }).listThreads({ force: true });

  assert.equal(result.total, 2);
  assert.deepEqual(result.threads.map(({ id }) => id), [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
  assert.equal(result.threads[0].project.name, "个人");
  assert.equal(result.threads[0].pinned, true);
  assert.equal(result.threads[0].conversationKind, "chatgpt");
  assert.equal(result.threads[0].openUrl, null);
  assert.equal(result.threads[1].project.name, "普通 Chat");
  assert.equal(result.threads[1].activity.state, "idle");
});
