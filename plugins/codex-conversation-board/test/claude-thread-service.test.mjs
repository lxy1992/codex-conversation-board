import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import {
  ClaudeThreadService,
  claudeOpenUrl,
} from "../server/claude-thread-service.js";

const DESKTOP_ID = "local_11111111-1111-4111-8111-111111111111";
const CLI_ID = "22222222-2222-4222-8222-222222222222";
const DUPLICATE_CLI_ID = "33333333-3333-4333-8333-333333333333";

test("merges Claude Desktop and CLI sessions without reading transcript bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-thread-service-"));
  const desktopRoot = join(directory, "desktop");
  const cliProjectsRoot = join(directory, "cli-projects");
  const desktopAccount = join(desktopRoot, "account", "workspace");
  const cliProject = join(cliProjectsRoot, "project-a");
  await Promise.all([
    mkdir(desktopAccount, { recursive: true }),
    mkdir(cliProject, { recursive: true }),
  ]);

  await writeFile(join(desktopAccount, `${DESKTOP_ID}.json`), JSON.stringify({
    sessionId: DESKTOP_ID,
    cliSessionId: DUPLICATE_CLI_ID,
    cwd: "/work/alpha",
    createdAt: 1_760_000_000_000,
    lastActivityAt: 1_760_000_200_000,
    lastFocusedAt: 1_760_000_300_000,
    title: "Desktop Claude session",
    isArchived: false,
  }));
  await writeFile(join(desktopAccount, "archived.json"), JSON.stringify({
    sessionId: "local_44444444-4444-4444-8444-444444444444",
    cwd: "/work/archive",
    title: "Archived",
    isArchived: true,
  }));
  await writeFile(join(desktopAccount, "malformed.json"), "{bad json");

  await writeFile(join(cliProject, "sessions-index.json"), JSON.stringify({
    version: 1,
    originalPath: "/work/beta",
    entries: [
      {
        sessionId: CLI_ID,
        summary: "CLI Claude session",
        firstPrompt: "fallback prompt",
        created: "2025-10-09T08:53:20.000Z",
        modified: "2025-10-09T08:56:40.000Z",
        projectPath: "/work/beta",
        gitBranch: "feat/claude",
        isSidechain: false,
      },
      {
        sessionId: DUPLICATE_CLI_ID,
        summary: "Duplicate imported session",
        projectPath: "/work/alpha",
        isSidechain: false,
      },
      {
        sessionId: "55555555-5555-4555-8555-555555555555",
        summary: "Sidechain",
        projectPath: "/work/beta",
        isSidechain: true,
      },
    ],
  }));

  const service = new ClaudeThreadService({ desktopRoot, cliProjectsRoot, cacheTtlMs: 0 });
  const result = await service.listThreads({ force: true });

  assert.equal(result.total, 2);
  assert.deepEqual(result.threads.map((thread) => thread.id), [DESKTOP_ID, CLI_ID]);

  const desktop = result.threads[0];
  assert.equal(desktop.title, "Desktop Claude session");
  assert.equal(desktop.project.name, "alpha");
  assert.equal(desktop.updatedAt, 1_760_000_200_000);
  assert.equal(desktop.openUrl, `claude://code/continue?session=${DESKTOP_ID}`);
  assert.equal(desktop.claudeSessionKind, "desktop");

  const cli = result.threads[1];
  assert.equal(cli.title, "CLI Claude session");
  assert.equal(cli.project.name, "beta");
  assert.equal(cli.branch, "feat/claude");
  assert.equal(cli.openUrl, `claude://resume?session=${CLI_ID}`);
  assert.equal(cli.claudeSessionKind, "cli");
  assert.equal(result.diagnostics.desktop.loaded, 1);
  assert.equal(result.diagnostics.cli.loaded, 1);
});

test("builds only allow-listed Claude deep links", () => {
  assert.equal(
    claudeOpenUrl(DESKTOP_ID),
    `claude://code/continue?session=${DESKTOP_ID}`,
  );
  assert.equal(claudeOpenUrl(CLI_ID), `claude://resume?session=${CLI_ID}`);
  assert.throws(() => claudeOpenUrl("../../Applications/Calculator.app"), /无效的 Claude 会话 ID/);
});
