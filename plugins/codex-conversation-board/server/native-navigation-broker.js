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
          writeJsonLine(socket, { ok: true });
          return;
        }
        if (typeof request?.threadId !== "string" || !request.threadId.trim()) {
          throw new Error("缺少 ChatGPT 对话编号");
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
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error("Codex 网页导航代理响应超时"));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      rejectRequest(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify(healthOnly ? { health: true } : { threadId, requestId })}\n`);
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
      if (response?.ok !== true) rejectRequest(new Error(response?.error || "Codex 网页导航代理失败"));
      else resolveRequest(response);
    });
  });
}
