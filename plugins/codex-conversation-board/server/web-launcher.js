import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";

/**
 * 保证网页版服务可用后再打开页面。所有外部动作都可注入，便于精确测试“一键启动”流程。
 */
export async function ensureWebBoardReady({
  checkReady,
  startServer,
  openBoard,
  sleep = (milliseconds) => sleepFor(milliseconds),
  retryDelayMs = 100,
  maxAttempts = 120,
  logPath = "",
}) {
  if (await checkReady()) {
    await openBoard();
    return;
  }

  startServer();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(retryDelayMs);
    if (await checkReady()) {
      await openBoard();
      return;
    }
  }

  const logHint = logPath ? `，日志：${logPath}` : "";
  throw new Error(`网页版服务未能在 ${maxAttempts * retryDelayMs}ms 内启动${logHint}`);
}

/**
 * 仅检查本机健康接口；超时或连接失败都视为服务尚未启动。
 */
export async function isWebBoardReady(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${url}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.service === "codex-conversation-board-web";
  } catch {
    return false;
  }
}

/**
 * 后台启动 Node 服务并把输出写入用户日志目录，启动器本身可以立即退出且不会留下终端窗口。
 */
export function startDetachedWebBoard({ projectRoot, port, logPath }) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [path.join(projectRoot, "server", "web.mjs")], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        CODEX_BOARD_WEB_PORT: String(port),
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

/**
 * 使用系统默认浏览器打开看板；测试或自动化检查可通过环境变量跳过这一步。
 */
export async function openWebBoard(url) {
  if (process.env.CODEX_BOARD_SKIP_OPEN === "1") return;

  let command;
  let args;
  if (process.platform === "darwin") {
    command = "/usr/bin/open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  await new Promise((resolve, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * 一键启动网页版：已有服务时直接打开；否则静默拉起服务，等待就绪后打开。
 */
export async function launchWebBoard({ projectRoot, port = 4765 } = {}) {
  if (!projectRoot) throw new Error("缺少项目目录");
  const url = `http://127.0.0.1:${port}`;
  const logPath = path.join(homedir(), "Library", "Logs", "CodexConversationBoard", "web.log");

  await ensureWebBoardReady({
    checkReady: () => isWebBoardReady(url),
    startServer: () => startDetachedWebBoard({ projectRoot, port, logPath }),
    openBoard: () => openWebBoard(url),
    logPath,
  });

  return { url, logPath };
}

/**
 * 为 macOS App 安装器选择不随 nvm 当前版本切换而变化的 Node 路径。
 */
export function findStableNodePath() {
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? process.execPath;
}
