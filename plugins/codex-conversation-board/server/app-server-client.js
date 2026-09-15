import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { timestampMs } from "./time.js";

const DEFAULT_CLI_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "codex",
];

function isExecutable(path) {
  if (path === "codex") return true;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexCli(explicitPath = process.env.CODEX_CLI_PATH) {
  if (explicitPath) return explicitPath;
  return DEFAULT_CLI_CANDIDATES.find(isExecutable) ?? "codex";
}

export class AppServerClient extends EventEmitter {
  constructor({ cliPath, requestTimeoutMs = 20_000, logger = console } = {}) {
    super();
    this.cliPath = resolveCodexCli(cliPath);
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
  }

  async start() {
    if (this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startInternal() {
    const child = spawn(this.cliPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#handleLine(line));

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (process.env.CODEX_BOARD_DEBUG === "1") {
        this.logger.error(`[app-server] ${line}`);
      }
    });

    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      this.#handleExit(
        new Error(`Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-conversation-board",
        title: "Codex Conversation Board",
        version: "0.8.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocol-error", new Error(`Invalid App Server JSON: ${line.slice(0, 200)}`));
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #handleExit(error) {
    if (!this.process) return;
    this.process = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #write(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error("Codex App Server is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    const message = params === undefined ? { method } : { method, params };
    this.#write(message);
  }

  async listThreads({ limit = 1_200, updatedSince = null } = {}) {
    await this.start();
    const threads = [];
    let cursor = null;

    while (threads.length < limit) {
      const pageSize = Math.min(100, limit - threads.length);
      const result = await this.request("thread/list", {
        cursor,
        limit: pageSize,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
        useStateDbOnly: true,
      });

      const page = result?.data ?? result?.threads ?? [];
      threads.push(...page);
      cursor = result?.nextCursor ?? null;
      const crossedBoundary = updatedSince != null && page.some((thread) => {
        const updatedAt = timestampMs(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt);
        return updatedAt != null && updatedAt < updatedSince;
      });
      if (!cursor || page.length === 0 || crossedBoundary) break;
    }

    return threads.slice(0, limit);
  }

  async readThread(threadId) {
    await this.start();
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    return result?.thread ?? result ?? null;
  }

  async readThreads(threadIds) {
    await this.start();
    const results = await Promise.allSettled(
      [...new Set(threadIds)].map((threadId) => this.readThread(threadId)),
    );
    return results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
  }

  async close() {
    const child = this.process;
    if (!child) return;
    this.process = null;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
