import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = "/private/tmp/codex-board-mcp-app-host";
const boardPath = resolve(outputDirectory, "board.html");
const hostPath = resolve(outputDirectory, "index.html");

const columns = [
  ["inbox", "收件箱", "刚出现、尚未分类"],
  ["todo", "待处理", "已经明确，等待开始"],
  ["doing", "进行中", "当前正在推进"],
  ["blocked", "阻塞", "等待输入、审批或外部条件"],
  ["review", "待验收", "工作完成，等待确认"],
  ["done", "完成", "已经结束"],
].map(([id, label, description]) => ({ id, label, description }));

const thread = {
  id: "00000001-1111-4111-8111-111111111111",
  title: "协议连接后可以打开的对话",
  project: { id: "codex", name: "Codex Tools" },
  runtime: { state: "unknown", label: "未加载" },
  updatedAt: Date.now(),
  branch: null,
  openUrl: "codex://threads/00000001-1111-4111-8111-111111111111",
  activity: {
    state: "idle",
    label: "",
    unread: false,
    startedAt: null,
    completedAt: null,
  },
  boardStatus: "inbox",
  boardPosition: 0,
};

const snapshot = {
  snapshotVersion: 2,
  generatedAt: new Date().toISOString(),
  activitySourceVersion: 2,
  columns,
  projects: [{ id: "codex", name: "Codex Tools", count: 1 }],
  threads: [thread],
  total: 1,
  columnCounts: Object.fromEntries(columns.map((column) => [column.id, column.id === "inbox" ? 1 : 0])),
  doneLoaded: true,
  donePreviewMode: "today",
  donePreviewDate: new Date().toISOString().slice(0, 10),
  donePreviewCount: 0,
};

const boardSource = await readFile(resolve(root, "ui/board.html"), "utf8");
const hostBridgeScript = `<script>
  window.openai = {
    openExternal: ({ href }) => {
      window.parent.postMessage({
        type: "test-open-external",
        href,
        userActivation: navigator.userActivation?.isActive === true,
      }, "*");
    },
  };
</script>`;
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  boardPath,
  boardSource
    .replace("__CODEX_BOARD_BOOTSTRAP__", JSON.stringify(snapshot))
    .replace("    <script>\n      (() => {", `${hostBridgeScript}\n    <script>\n      (() => {`),
);

const hostSource = `<!doctype html>
<html>
  <body>
    <iframe id="app" src="./board.html" style="width:1200px;height:800px"></iframe>
    <script>
      const sequence = [];
      let initialized = false;
      document.body.dataset.sequence = "";

      function record(value) {
        sequence.push(value);
        document.body.dataset.sequence = sequence.join(",");
      }

      window.addEventListener("message", (event) => {
        if (event.source !== document.querySelector("#app").contentWindow) return;
        const message = event.data;
        if (message?.type === "test-open-external") {
          document.body.dataset.openExternal = message.href;
          document.body.dataset.openExternalActive = String(message.userActivation);
          if (message.userActivation) document.body.dataset.openedThread = message.href;
          return;
        }
        if (!message || message.jsonrpc !== "2.0") return;

        if (message.method === "ui/initialize") {
          record("ui/initialize");
          event.source.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "strict-test-host", version: "1.0.0" },
              hostCapabilities: { serverTools: {} },
              hostContext: { theme: "dark" },
            },
          }, "*");
          return;
        }

        if (message.method === "ui/notifications/initialized") {
          initialized = true;
          record("ui/notifications/initialized");
          return;
        }

        if (message.method === "tools/call") {
          record("tools/call:" + message.params?.name);
          // A conforming strict host ignores app tool calls made before the
          // MCP Apps initialization handshake has completed.
          if (!initialized) return;
          if (message.params?.name === "open_thread") {
            if (window.__DROP_OPEN_THREAD__) return;
            document.body.dataset.openedThread = message.params.arguments.threadId;
          }
          event.source.postMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [],
              structuredContent: { ok: true, ...message.params?.arguments },
            },
          }, "*");
        }
      });
    </script>
  </body>
</html>`;

await writeFile(hostPath, hostSource);
process.stdout.write(`${hostPath}\n`);
