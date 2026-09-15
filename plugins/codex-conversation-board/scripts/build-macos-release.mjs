#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
}

if (process.platform !== "darwin") {
  throw new Error("The macOS release package must be built on macOS.");
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const outputDirectory = path.resolve(
  process.env.CODEX_BOARD_RELEASE_DIR ?? path.join(projectRoot, "dist"),
);
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "conversation-board-release-"));
const stagingDirectory = path.join(temporaryRoot, "dmg");
const appPath = path.join(stagingDirectory, "AI 对话看板.app");
const artifactName = `AI-Conversation-Board-${packageInfo.version}-macOS-universal.dmg`;
const artifactPath = path.join(outputDirectory, artifactName);

mkdirSync(stagingDirectory, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });

try {
  run(process.execPath, [path.join(projectRoot, "scripts", "install-macos-app.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_BOARD_APP_PATH: appPath,
      CODEX_BOARD_APP_ARCHS: "arm64,x86_64",
      CODEX_BOARD_NODE_PATH: "",
    },
  });

  symlinkSync("/Applications", path.join(stagingDirectory, "Applications"));
  writeFileSync(path.join(stagingDirectory, "安装说明.txt"), `AI Conversation Board ${packageInfo.version}

1. Drag “AI 对话看板” to Applications.
2. Make sure Codex Desktop is installed. The app uses its local runtime and conversation metadata.
3. If macOS blocks the first launch, right-click the app and choose Open.

For the Codex plugin and source code:
https://github.com/lxy1992/codex-conversation-board
`, "utf8");

  rmSync(artifactPath, { force: true });
  run("/usr/bin/hdiutil", [
    "create",
    "-volname", "AI Conversation Board",
    "-srcfolder", stagingDirectory,
    "-ov",
    "-format", "UDZO",
    artifactPath,
  ]);

  const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  writeFileSync(`${artifactPath}.sha256`, `${digest}  ${artifactName}\n`, "utf8");
  console.log(`Release package: ${artifactPath}`);
  console.log(`SHA-256: ${digest}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
