import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SERVER_PATH = resolve(ROOT_DIR, "server/server.mjs");
const PACKAGED_CODEX_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

function serverRuntime(env) {
  const candidates = [env.CODEX_MCP_NODE_PATH, PACKAGED_CODEX_NODE, process.execPath];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? process.execPath;
}

export class McpProcessClient {
  constructor({
    serverPath = DEFAULT_SERVER_PATH,
    cwd = ROOT_DIR,
    env = process.env,
    logger = console,
    timeoutMs = 60_000,
  } = {}) {
    this.serverPath = serverPath;
    this.cwd = cwd;
    this.env = env;
    this.childEnv = { ...env, CODEX_BOARD_WEB_WORKER: "1" };
    this.runtimePath = serverRuntime(env);
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.closing = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.child = spawn(this.runtimePath, [this.serverPath], {
        cwd: this.cwd,
        env: this.childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "MCP 工具调用失败"));
        else pending.resolve(message.result);
      });
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => {
        const message = String(chunk).trim();
        if (message) this.logger.error?.(message);
      });
      this.child.once("exit", (code, signal) => {
        this.child = null;
        if (this.closing) return;
        const error = new Error(`看板 MCP 进程已退出（code=${code}, signal=${signal}）`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
      this.child.once("error", (error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });

      await this.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex-conversation-board-web", version: "0.8.1" },
      });
    })();
    return this.startPromise;
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("看板 MCP 进程尚未启动"));
    }
    return new Promise((resolveRequest, rejectRequest) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`看板 MCP 请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async callTool(name, args = {}) {
    await this.start();
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
    if (this.child) this.child.kill("SIGTERM");
  }
}

export const mcpProcessClientInternals = { serverRuntime };
