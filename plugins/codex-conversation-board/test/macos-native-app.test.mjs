import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("macOS installer builds a native WebKit app instead of a browser-opening shell launcher", {
  skip: process.platform !== "darwin",
}, () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "conversation-board-native-app-"));
  const appPath = path.join(tempRoot, "AI 对话看板.app");

  try {
    const install = spawnSync(process.execPath, ["scripts/install-macos-app.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_BOARD_APP_PATH: appPath },
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const executablePath = path.join(appPath, "Contents", "MacOS", "AIConversationBoard");
    const executableKind = spawnSync("/usr/bin/file", [executablePath], { encoding: "utf8" });
    assert.match(executableKind.stdout, /Mach-O .* executable/);

    const plistPath = path.join(appPath, "Contents", "Info.plist");
    const plist = readFileSync(plistPath, "utf8");
    assert.match(plist, /<key>BoardLauncherPath<\/key>/);
    assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>/);
    assert.doesNotMatch(plist, /default browser/i);
    assert.doesNotMatch(plist, new RegExp(projectRoot.replaceAll("/", "\\/")));
    const launcherSetting = spawnSync("/usr/bin/plutil", [
      "-extract", "BoardLauncherPath", "raw", plistPath,
    ], { encoding: "utf8" });
    assert.equal(launcherSetting.status, 0, launcherSetting.stderr);
    assert.equal(launcherSetting.stdout.trim(), "board/scripts/launch-web-board.mjs");
    assert.equal(path.isAbsolute(launcherSetting.stdout.trim()), false);

    const bundledRoot = path.join(appPath, "Contents", "Resources", "board");
    assert.ok(readFileSync(path.join(bundledRoot, "scripts", "launch-web-board.mjs"), "utf8"));
    assert.ok(readFileSync(path.join(bundledRoot, "server", "web.mjs"), "utf8"));
    assert.ok(readFileSync(path.join(bundledRoot, "ui", "board.html"), "utf8"));

    const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
      encoding: "utf8",
    });
    assert.equal(signature.status, 0, signature.stderr);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
