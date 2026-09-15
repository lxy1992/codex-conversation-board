import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_NATIVE_NAVIGATION_BROKER_PATH,
  requestBrokerNavigation,
} from "./native-navigation-broker.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const NAVIGATION_TOOL = "navigate_to_codex_page";
const DEFAULT_PIPE_DIRECTORY = resolve(tmpdir(), "codex-browser-use");
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");
const DEFAULT_CATALOG_PATH = resolve(DEFAULT_CODEX_HOME, "sqlite/codex-dev.db");
const DEFAULT_CACHE_PATH = resolve(DEFAULT_CODEX_HOME, "conversation-board/native-navigation.json");

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex 原生导航请求过大");
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function stringMetadata(metadata, keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function nestedMetadataId(metadata, key) {
  const value = metadata?.[key];
  return value && typeof value === "object" && typeof value.id === "string" && value.id.trim()
    ? value.id.trim()
    : null;
}

function turnMetadata(value) {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === "object" ? decoded : null;
}

function executorThreadId(metadata = {}) {
  const parsedTurn = turnMetadata(metadata["x-codex-turn-metadata"]);
  return stringMetadata(metadata, [
    "openai/threadId",
    "openai/thread_id",
    "codexThreadId",
    "codex_thread_id",
    "threadId",
    "thread_id",
  ]) ?? (typeof parsedTurn?.thread_id === "string" && parsedTurn.thread_id.trim()
    ? parsedTurn.thread_id.trim()
    : null) ?? nestedMetadataId(metadata, "thread");
}

function executorTurnId(metadata = {}, requestId = randomUUID()) {
  const parsedTurn = turnMetadata(metadata["x-codex-turn-metadata"]);
  return stringMetadata(metadata, [
    "openai/turnId",
    "openai/turn_id",
    "codexTurnId",
    "codex_turn_id",
    "turnId",
    "turn_id",
  ]) ?? (typeof parsedTurn?.turn_id === "string" && parsedTurn.turn_id.trim()
    ? parsedTurn.turn_id.trim()
    : null) ?? nestedMetadataId(metadata, "turn") ?? `board-turn-${requestId}`;
}

function executorCallId(metadata = {}) {
  return stringMetadata(metadata, [
    "openai/toolCallId",
    "openai/tool_call_id",
    "codexCallId",
    "codex_call_id",
    "callId",
    "call_id",
  ]) ?? nestedMetadataId(metadata, "call") ?? `board-call-${randomUUID()}`;
}

/**
 * Codex 桌面端原生工具使用长度前缀 JSON 帧。这个客户端只负责一条本机
 * Unix socket，连接断开时会让所有等待中的请求立即失败，避免卡片一直转圈。
 */
class NativePipeClient {
  constructor(pipePath, { requestTimeoutMs = 20_000 } = {}) {
    this.pipePath = pipePath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.connecting = null;
    this.pendingData = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect(timeoutMs = 2_000) {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolveConnect, rejectConnect) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectConnect(new Error("连接 Codex 原生导航超时"));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectConnect(error);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk) => this.#onData(socket, chunk));
        socket.on("error", (error) => this.#disconnect(socket, error));
        socket.on("close", () => this.#disconnect(socket, new Error("Codex 原生导航连接已关闭")));
        resolveConnect();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    await this.connect(Math.min(timeoutMs, 2_000));
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex 原生导航连接不可用");
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        try {
          socket.write(encodeFrame({ jsonrpc: "2.0", id, method: "tools/cancel" }));
        } catch {
          // 连接可能已经关闭；原始超时错误更有用。
        }
        rejectRequest(new Error("Codex 原生导航响应超时"));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      socket.write(encodeFrame({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    });
  }

  #onData(socket, chunk) {
    if (socket !== this.socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.#disconnect(socket, new Error("Codex 原生导航响应过大"));
        socket.destroy();
        return;
      }
      if (this.pendingData.length < length + 4) return;
      const payload = this.pendingData.subarray(4, length + 4);
      this.pendingData = this.pendingData.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.#disconnect(socket, new Error("Codex 原生导航响应格式错误"));
        socket.destroy();
        return;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || "Codex 原生导航失败"));
      else pending.resolve(message.result);
    }
  }

  #disconnect(socket, error) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    for (const pending of this.pending.values()) pending.reject(new Error("Codex 原生导航已关闭"));
    this.pending.clear();
  }
}

async function latestLocalCodexThreadId(catalogPath) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const row = database.prepare(`
        SELECT thread_id
        FROM local_thread_catalog
        WHERE source_kind != 'chatgpt' AND missing_candidate = 0
        ORDER BY source_recency_at DESC
        LIMIT 1
      `).get();
      return typeof row?.thread_id === "string" && row.thread_id.trim() ? row.thread_id.trim() : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

async function cachedPipePath(cachePath) {
  try {
    const value = JSON.parse(await readFile(cachePath, "utf8"));
    return typeof value?.pipePath === "string" && value.pipePath.trim() ? value.pipePath.trim() : null;
  } catch {
    return null;
  }
}

async function discoveredPipePaths(pipeDirectory) {
  try {
    const entries = await readdir(pipeDirectory);
    const candidates = await Promise.all(entries
      .filter((entry) => entry.endsWith(".sock"))
      .map(async (entry) => {
        const path = resolve(pipeDirectory, entry);
        try {
          const details = await stat(path);
          return details.isSocket() ? { path, mtimeMs: details.mtimeMs } : null;
        } catch {
          return null;
        }
      }));
    return candidates
      .filter(Boolean)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 24)
      .map(({ path }) => path);
  } catch {
    return [];
  }
}

async function rememberPipePath(cachePath, pipePath) {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ pipePath, updatedAt: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, cachePath);
  } catch {
    // 缓存失败不影响这次已经成功的跳转。
  }
}

/**
 * 把 ChatGPT 对话 ID 交给 Codex 桌面端的原生导航工具。MCP App 优先使用
 * 当前工具调用携带的任务上下文；独立网页则回退到本机最近的 Codex 任务。
 */
export class CodexAppNavigator {
  constructor({
    pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH,
    interactionThreadId = process.env.CODEX_THREAD_ID,
    catalogPath = process.env.CODEX_CHATGPT_CATALOG_PATH || DEFAULT_CATALOG_PATH,
    cachePath = process.env.CODEX_BOARD_NATIVE_NAVIGATION_PATH || DEFAULT_CACHE_PATH,
    pipeDirectory = process.env.CODEX_APP_TOOLS_PIPE_DIRECTORY || DEFAULT_PIPE_DIRECTORY,
    requestTimeoutMs = 20_000,
    useBroker = process.env.CODEX_BOARD_WEB_WORKER === "1",
    brokerPath = process.env.CODEX_BOARD_NATIVE_BROKER_PATH || DEFAULT_NATIVE_NAVIGATION_BROKER_PATH,
    logger = console,
  } = {}) {
    this.pipePath = pipePath?.trim() || null;
    this.interactionThreadId = interactionThreadId?.trim() || null;
    this.catalogPath = catalogPath;
    this.cachePath = cachePath;
    this.pipeDirectory = pipeDirectory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.useBroker = useBroker;
    this.brokerPath = brokerPath;
    this.logger = logger;
    this.clients = new Map();
  }

  async #candidatePipePaths() {
    const paths = [
      this.pipePath,
      await cachedPipePath(this.cachePath),
      ...await discoveredPipePaths(this.pipeDirectory),
    ].filter(Boolean);
    return [...new Set(paths)];
  }

  async #interactionThread(metadata) {
    return executorThreadId(metadata)
      ?? this.interactionThreadId
      ?? await latestLocalCodexThreadId(this.catalogPath);
  }

  async navigateToThread(targetThreadId, { metadata = {}, requestId = randomUUID() } = {}) {
    if (this.useBroker) {
      const result = await requestBrokerNavigation({
        socketPath: this.brokerPath,
        threadId: targetThreadId,
        requestId,
        timeoutMs: this.requestTimeoutMs + 2_000,
      });
      return {
        navigated: result.navigated === true,
        navigation: result.navigation || "codex-app",
      };
    }
    const interactionThreadId = await this.#interactionThread(metadata);
    if (!interactionThreadId) throw new Error("找不到可用于原生跳转的 Codex 任务");
    const candidates = await this.#candidatePipePaths();
    if (candidates.length === 0) throw new Error("Codex 原生导航通道尚未启动");

    let lastError = null;
    for (const pipePath of candidates) {
      const client = this.clients.get(pipePath) ?? new NativePipeClient(pipePath, {
        requestTimeoutMs: this.requestTimeoutMs,
      });
      this.clients.set(pipePath, client);
      try {
        const listed = await client.request("tools/list", { threadStartKind: "all" }, {
          timeoutMs: Math.min(this.requestTimeoutMs, 2_500),
        });
        const tool = listed?.tools?.find((item) => item?.name === NAVIGATION_TOOL);
        if (!tool?.namespace) throw new Error("该通道没有 Codex 对话导航能力");
        const result = await client.request("tools/call", {
          arguments: { threadId: targetThreadId },
          callId: executorCallId(metadata),
          namespace: tool.namespace,
          threadId: interactionThreadId,
          tool: NAVIGATION_TOOL,
          turnId: executorTurnId(metadata, requestId),
        });
        if (result?.success !== true) throw new Error("Codex 没有接受这次对话跳转");
        this.pipePath = pipePath;
        rememberPipePath(this.cachePath, pipePath);
        return { navigated: true, navigation: "codex-app" };
      } catch (error) {
        lastError = error;
        client.close();
        this.clients.delete(pipePath);
      }
    }
    this.logger.error?.(`Codex 原生导航失败: ${lastError?.message ?? "未知错误"}`);
    throw new Error("无法在 Codex 中打开这个 ChatGPT 对话");
  }

  async close() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

export const codexAppNavigatorInternals = {
  NativePipeClient,
  discoveredPipePaths,
  executorCallId,
  executorThreadId,
  executorTurnId,
  latestLocalCodexThreadId,
};
