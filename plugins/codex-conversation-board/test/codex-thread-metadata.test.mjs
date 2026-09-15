import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CodexThreadMetadataService } from "../server/codex-thread-metadata.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const CHATGPT = "33333333-3333-4333-8333-333333333333";

test("reads renamed Codex titles in one local catalog batch without ChatGPT rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-board-title-catalog-"));
  const catalogPath = join(directory, "catalog.sqlite");
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
      missing_candidate INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(`
    INSERT INTO local_thread_catalog (
      host_id, thread_id, display_title, source_created_at, source_updated_at,
      source_recency_at, source_kind, missing_candidate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("local", FIRST, "  已   重命名的对话  ", 1, 3, 3, "vscode", 0);
  insert.run("remote", SECOND, "较旧标题", 1, 2, 2, "cli", 0);
  insert.run("local", SECOND, "最新标题", 1, 4, 4, "vscode", 0);
  insert.run("chatgpt:account", CHATGPT, "ChatGPT 标题", 1, 5, 5, "chatgpt", 0);
  database.close();

  const metadata = await new CodexThreadMetadataService({ catalogPath }).read([
    FIRST,
    SECOND,
    CHATGPT,
  ]);

  assert.deepEqual(metadata, {
    [FIRST]: { title: "已 重命名的对话" },
    [SECOND]: { title: "最新标题" },
  });
});

test("returns no metadata when the local catalog is unavailable", async () => {
  const service = new CodexThreadMetadataService({ catalogPath: "/missing/codex-catalog.sqlite" });
  assert.deepEqual(await service.read([FIRST]), {});
});
