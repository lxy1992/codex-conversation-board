import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const DEFAULT_NATIVE_NAVIGATION_BROKER_PATH = process.env.CODEX_BOARD_NATIVE_BROKER_PATH
  || resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "conversation-board/native-navigation.sock");

function writeJsonLine(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

/**
 * 插件 MCP 进程由 Codex 直接启动，因此有权限调用原生导航。这个仅限当前
 * macOS 用户的 Unix socket 把该能力转给独立网页，不对网络开放。
 */
export class NativeNavigationBroker {
  constructor({ navigator, socketPath = DEFAULT_NATIVE_NAVIGATION_BROKER_PATH, logger = console } = {}) {
    if (!navigator?.navigateToThread) throw new TypeError("navigator is required");
    this.navigator = navigator;
    this.socketPath = socketPath;
    this.logger = logger;
    this.server = null;
    this.ownsSocket = false;
  }

  async start() {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = net.createServer((socket) => this.#handle(socket));
      try {
        await new Promise((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(this.socketPath, resolveListen);
        });
        await chmod(this.socketPath, 0o600);
        this.server = server;
        this.ownsSocket = true;
        return;
      } catch (error) {
        server.close();
        if (error?.code !== "EADDRINUSE" || attempt > 0) throw error;
        try {
          await requestBrokerNavigation({
            socketPath: this.socketPath,
            threadId: "__health__",
            timeoutMs: 300,
            healthOnly: true,
          });
          // 已有插件实例在提供服务；当前实例无需抢占。
          this.server = server;
          this.ownsSocket = false;
          return;
        } catch {
          await unlink(this.socketPath).catch(() => {});
        }
      }
    }
  }

  #handle(socket) {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) socket.destroy();
      if (!body.includes("\n")) return;
      const line = body.slice(0, body.indexOf("\n"));
      socket.pause();
      Promise.resolve().then(async () => {
        const request = JSON.parse(line);
        if (request?.health === true) {
          writeJsonLine(socket, {
            ok: true,
            capabilities: ["navigate", "set-read-state"],
          });
          return;
        }
        if (typeof request?.threadId !== "string" || !request.threadId.trim()) {
          throw new Error("缺少对话编号");
        }
        if (request.action === "set-read-state") {
          if (typeof this.navigator.setThreadReadState !== "function") {
            throw new Error("当前 Codex 通道不支持更新已读状态");
          }
          const result = await this.navigator.setThreadReadState(
            request.threadId.trim(),
            request.read !== false,
            { requestId: request.requestId },
          );
          writeJsonLine(socket, { ok: true, ...result });
          return;
        }
        const result = await this.navigator.navigateToThread(request.threadId.trim(), {
          requestId: request.requestId,
        });
        writeJsonLine(socket, { ok: true, ...result });
      }).catch((error) => {
        writeJsonLine(socket, { ok: false, error: error?.message || "Codex 原生导航失败" });
      });
    });
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (server && this.ownsSocket) {
      await new Promise((resolveClose) => server.close(resolveClose));
      await unlink(this.socketPath).catch(() => {});
    }
    this.ownsSocket = false;
  }
}

export function requestBrokerNavigation({
  socketPath = DEFAULT_NATIVE_NAVIGATION_BROKER_PATH,
  threadId,
  requestId,
  timeoutMs = 22_000,
  healthOnly = false,
} = {}) {
  return requestBrokerAction({
    socketPath,
    request: healthOnly ? { health: true } : { action: "navigate", threadId, requestId },
    timeoutMs,
    timeoutMessage: "Codex 网页导航代理响应超时",
    failureMessage: "Codex 网页导航代理失败",
  });
}

export async function requestBrokerReadState({
  socketPath = DEFAULT_NATIVE_NAVIGATION_BROKER_PATH,
  threadId,
  read = true,
  requestId,
  timeoutMs = 22_000,
} = {}) {
  // 0.8.x brokers treated every request containing threadId as navigation. Probe first so an
  // upgraded standalone app never opens the card by accident while Codex still runs an old broker.
  const health = await requestBrokerAction({
    socketPath,
    request: { health: true },
    timeoutMs: Math.min(timeoutMs, 1_000),
    timeoutMessage: "Codex 已读状态代理响应超时",
    failureMessage: "Codex 已读状态代理失败",
  });
  if (!health.capabilities?.includes("set-read-state")) {
    throw new Error("请重启 Codex 以启用已读状态同步");
  }
  return requestBrokerAction({
    socketPath,
    request: { action: "set-read-state", threadId, read, requestId },
    timeoutMs,
    timeoutMessage: "Codex 已读状态代理响应超时",
    failureMessage: "Codex 已读状态代理失败",
  });
}

function requestBrokerAction({ socketPath, request, timeoutMs, timeoutMessage, failureMessage }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error(timeoutMessage));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      rejectRequest(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      clearTimeout(timer);
      socket.off("error", fail);
      let response;
      try {
        response = JSON.parse(body.slice(0, body.indexOf("\n")));
      } catch {
        rejectRequest(new Error("Codex 网页导航代理响应格式错误"));
        socket.destroy();
        return;
      }
      socket.end();
      if (response?.ok !== true) rejectRequest(new Error(response?.error || failureMessage));
      else resolveRequest(response);
    });
  });
}
