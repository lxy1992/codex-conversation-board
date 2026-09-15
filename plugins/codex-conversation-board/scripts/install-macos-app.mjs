#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败（${result.status}）`);
  }
}

if (process.platform !== "darwin") {
  throw new Error("原生窗口安装器目前仅支持 macOS");
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const appPath = process.env.CODEX_BOARD_APP_PATH
  ?? path.join(homedir(), "Applications", "AI 对话看板.app");
const contentsPath = path.join(appPath, "Contents");
const executablePath = path.join(contentsPath, "MacOS", "AIConversationBoard");
const resourcesPath = path.join(contentsPath, "Resources");
const runtimePath = path.join(resourcesPath, "board");
const swiftSourcePath = path.join(projectRoot, "macos", "ConversationBoardApp.swift");
const launcherPath = path.join("board", "scripts", "launch-web-board.mjs");
const nodePath = process.env.CODEX_BOARD_NODE_PATH?.trim() ?? "";
const iconSourcePath = path.join(projectRoot, "assets", "ConversationBoard.icns");
const port = Number.parseInt(process.env.CODEX_BOARD_WEB_PORT ?? "4765", 10);
const boardPort = Number.isInteger(port) && port > 0 && port < 65_536 ? port : 4765;
const moduleCachePath = path.join(tmpdir(), "codex-conversation-board-swift-module-cache");

rmSync(appPath, { recursive: true, force: true });
mkdirSync(path.dirname(executablePath), { recursive: true });
mkdirSync(resourcesPath, { recursive: true });
mkdirSync(moduleCachePath, { recursive: true });

for (const directory of ["server", "scripts", "ui"]) {
  cpSync(path.join(projectRoot, directory), path.join(runtimePath, directory), {
    recursive: true,
  });
}
copyFileSync(path.join(projectRoot, "package.json"), path.join(runtimePath, "package.json"));

let iconEntry = "";
if (existsSync(iconSourcePath)) {
  copyFileSync(iconSourcePath, path.join(resourcesPath, "ConversationBoard.icns"));
  iconEntry = "\n  <key>CFBundleIconFile</key>\n  <string>ConversationBoard</string>";
}

writeFileSync(
  path.join(contentsPath, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>AI 对话看板</string>
  <key>CFBundleExecutable</key>
  <string>AIConversationBoard</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex.conversation-board</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AI 对话看板</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${xmlEscape(packageInfo.version)}</string>
  <key>CFBundleVersion</key>
  <string>${xmlEscape(packageInfo.version)}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>BoardLauncherPath</key>
  <string>${xmlEscape(launcherPath)}</string>
  <key>BoardNodePath</key>
  <string>${xmlEscape(nodePath)}</string>
  <key>BoardURL</key>
  <string>http://127.0.0.1:${boardPort}</string>${iconEntry}
</dict>
</plist>
`,
  "utf8",
);

const nativeArchitecture = process.arch === "arm64" ? "arm64" : "x86_64";
const architectures = (process.env.CODEX_BOARD_APP_ARCHS ?? nativeArchitecture)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (architectures.length === 0 || architectures.some((value) => !["arm64", "x86_64"].includes(value))) {
  throw new Error("CODEX_BOARD_APP_ARCHS 只支持 arm64 和 x86_64");
}

const compiledPaths = architectures.map((architecture) => {
  const outputPath = architectures.length === 1
    ? executablePath
    : path.join(tmpdir(), `AIConversationBoard-${process.pid}-${architecture}`);
  run("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    "-parse-as-library",
    "-module-cache-path", path.join(moduleCachePath, architecture),
    "-swift-version", "5",
    "-framework", "AppKit",
    "-framework", "WebKit",
    "-target", `${architecture}-apple-macos13.0`,
    swiftSourcePath,
    "-o", outputPath,
  ]);
  return outputPath;
});
if (compiledPaths.length > 1) {
  run("/usr/bin/lipo", ["-create", ...compiledPaths, "-output", executablePath]);
  for (const compiledPath of compiledPaths) rmSync(compiledPath, { force: true });
}
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);

const launchServicesRegister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
if (existsSync(launchServicesRegister)) {
  const registration = spawnSync(launchServicesRegister, ["-f", appPath], { stdio: "ignore" });
  if (registration.error || registration.status !== 0) {
    console.warn("LaunchServices 暂未登记 App；首次打开时 macOS 会自动登记。");
  }
}

console.log(`已安装原生窗口 App：${appPath}`);
console.log("以后从 Raycast、Spotlight、访达或程序坞打开“AI 对话看板”即可。");
