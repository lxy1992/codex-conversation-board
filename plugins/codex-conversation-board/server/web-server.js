import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UI_PATH = resolve(ROOT_DIR, "ui/board.html");
const WEB_TOOLS = new Set([
  "get_fast_snapshot",
  "get_board",
  "get_thread_activity",
  "move_thread",
  "update_board_columns",
  "open_thread",
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, "application/json; charset=utf-8", JSON.stringify(value));
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求不是有效的 JSON"), { statusCode: 400 });
  }
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function webBridge(token) {
  const encodedToken = JSON.stringify(token).replace(/</g, "\\u003c");
  return `<script>
window.__CODEX_BOARD_WEB__ = Object.freeze({
  callTool: async (name, args = {}) => {
    const response = await fetch("/api/tools/" + encodeURIComponent(name), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-board-token": ${encodedToken},
      },
      body: JSON.stringify(args),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "网页看板工具调用失败");
    return result;
  },
});
window.__CODEX_BOARD_HOST__ = Object.freeze({
  requestDisplayMode: async ({ mode }) => {
    if (mode === "fullscreen" && document.fullscreenElement == null) {
      await document.documentElement.requestFullscreen();
    }
  },
});
document.title = "Codex 对话看板";
</script>`;
}

function injectBoardHtml(source, snapshot, token) {
  const bootstrap = JSON.stringify(snapshot ?? null).replace(/</g, "\\u003c");
  let html = source.replace("__CODEX_BOARD_BOOTSTRAP__", bootstrap);
  const bootstrapStart = html.indexOf('<script id="boardBootstrap"');
  const bootstrapEnd = bootstrapStart >= 0 ? html.indexOf("</script>", bootstrapStart) : -1;
  if (bootstrapStart < 0 || bootstrapEnd < 0) {
    throw new Error("看板页面缺少 boardBootstrap 注入点");
  }
  const insertAt = bootstrapEnd + "</script>".length;
  html = `${html.slice(0, insertAt)}\n    ${webBridge(token)}${html.slice(insertAt)}`;
  return html;
}

export function createBoardWebServer({
  callTool,
  uiPath = DEFAULT_UI_PATH,
  token = randomBytes(32).toString("base64url"),
  logger = console,
} = {}) {
  if (typeof callTool !== "function") throw new TypeError("callTool is required");

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, service: "codex-conversation-board-web" });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const [source, result] = await Promise.all([
          readFile(uiPath, "utf8"),
          callTool("get_fast_snapshot", {}),
        ]);
        const snapshot = result?.structuredContent ?? result?.structured_content ?? null;
        send(response, 200, "text/html; charset=utf-8", injectBoardHtml(source, snapshot, token));
        return;
      }

      const toolRoute = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (request.method === "POST" && toolRoute) {
        const name = decodeURIComponent(toolRoute[1]);
        if (!WEB_TOOLS.has(name)) {
          sendJson(response, 404, { error: "未知的网页看板操作" });
          return;
        }
        if (!tokenMatches(request.headers["x-codex-board-token"], token)) {
          sendJson(response, 403, { error: "网页看板操作令牌无效" });
          return;
        }
        const args = await readJsonBody(request);
        const result = await callTool(name, args);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logger.error?.(`网页看板请求失败: ${error?.message ?? error}`);
      sendJson(response, error?.statusCode ?? 500, {
        error: error?.statusCode ? error.message : "网页看板内部错误",
      });
    }
  });
}

export const webServerInternals = {
  injectBoardHtml,
  readJsonBody,
  tokenMatches,
};
