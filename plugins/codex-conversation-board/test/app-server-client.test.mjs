import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDefaultCodexCliCandidates,
  resolveCodexCli,
} from "../server/app-server-client.js";

test("discovers the Codex CLI bundled in current ChatGPT desktop builds", () => {
  const candidates = buildDefaultCodexCliCandidates("/Users/tester");

  assert.ok(candidates.includes(
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  ));
  assert.ok(candidates.includes(
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ));
  assert.ok(candidates.includes(
    "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  ));
});

test("chooses the first executable Codex CLI candidate", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-cli-candidate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  assert.equal(resolveCodexCli("", [path.join(directory, "missing"), executable]), executable);
});

test("keeps CODEX_CLI_PATH as the highest-priority override", () => {
  assert.equal(resolveCodexCli("/custom/codex", []), "/custom/codex");
});
