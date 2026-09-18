# AI Conversation Board / AI 对话看板

A local-first kanban board for **Codex tasks**, **ChatGPT chats synced into Codex**, and
**Claude Code sessions**. It ships as a Codex MCP App, a native macOS window, and a local web app.

本地优先的 AI 对话看板：用互相独立的页签整理 **Codex 任务**、**ChatGPT 对话**和
**Claude Code 会话**。既可作为 Codex MCP App 使用，也可安装成独立 macOS 窗口或启动网页版。

> This is not a replacement for the Codex sidebar. Codex currently renders the plugin inside a
> task and allows it to enter fullscreen mode.

## Features / 功能

- Six default lanes: Inbox, Todo, Doing, Blocked, Review, Done.
- Add, rename, recolor, remove, and reorder statuses independently for every source.
- Drag cards or use the per-card **Move to…** menu.
- Separate state, ordering, project filters, and fast snapshots for every source.
- The Done lane starts with today's completed conversations; older history loads on demand.
- Clicking a card returns to the matching Codex, ChatGPT, or Claude application view.
- Renamed conversation titles synchronize automatically without reloading the whole board.
- New conversations and lane changes refresh every 15 seconds while visible, and when the window regains focus.
- Completed catalog-backed conversations move back to Inbox after their local metadata changes.
- All board state stays on the local machine.

默认泳道是：收件箱、待处理、进行中、阻塞、待验收、完成。点击右上角设置按钮，
可以为每个来源分别新增、改名、换色、删除状态或调整泳道顺序。收件箱和完成可以改名、
换色和移动，但不能删除，以保留新对话接收和完成后新回复回流能力。删除其他状态时，
可以选择其中卡片的迁移目标。“完成”列默认只展示今天完成的内容，历史内容按需加载。

## Supported sources / 数据源

| Source | What is read | Open behavior | Live running / unread |
| --- | --- | --- | --- |
| Codex | Local Codex App Server metadata | Opens the Codex task | Supported from local lifecycle and native unread state |
| ChatGPT | Codex desktop's local ChatGPT catalog | Opens the chat inside Codex | Not exposed by the local catalog |
| Claude | Claude Desktop Code-session metadata plus Claude CLI `sessions-index.json` | Continues the session in Claude Desktop | Not exposed reliably; the board does not guess |

Claude support intentionally covers **Claude Code sessions**, not ordinary cloud conversations on
`claude.ai`. The plugin reads metadata only and never reads Claude JSONL transcript bodies.

Claude 页签只支持 **Claude Code**：优先读取 Claude Desktop 保存的 Code 会话，补充读取
Claude CLI 的会话索引；不会抓取 `claude.ai` 普通云端聊天，也不会读取 JSONL 对话正文。

## Requirements / 环境要求

- Node.js 22 or newer.
- Codex Desktop or a `codex` CLI available on `PATH` for the Codex tab.
- Claude Desktop and/or Claude Code CLI for the Claude tab.
- macOS is fully exercised today. Windows and Linux URL launching is implemented, but still needs
  release CI coverage.

## Native macOS app / macOS 独立窗口（推荐）

Download the latest universal macOS package from
[GitHub Releases](https://github.com/lxy1992/codex-conversation-board/releases/latest), open the
DMG, and drag **AI 对话看板** to Applications. The package supports Apple Silicon and Intel Macs
running macOS 13 or newer.

从 [GitHub Releases](https://github.com/lxy1992/codex-conversation-board/releases/latest)
下载最新版 DMG，打开后把 **AI 对话看板** 拖入“应用程序”即可。安装包同时支持 Apple Silicon
和 Intel Mac，系统要求为 macOS 13 或更高版本。

The release is ad-hoc signed but not Apple-notarized. On the first launch, macOS may require you to
right-click the app and choose **Open**.

首次启动如果被 macOS 拦截，请右键 App 并选择 **打开**。

To build and install the native WebKit app from source instead:

```bash
npm run app:install
```

After that, open **AI 对话看板** from Raycast, Spotlight, Finder, or the Dock. It displays the board
inside its own native window, starts the loopback service silently when needed, and does not open a
browser or Terminal window. Remove it with `npm run app:uninstall`.

只需安装一次。以后从 Raycast、Spotlight、访达或程序坞点击 **AI 对话看板**：它会在独立
原生窗口里展示看板，必要时静默启动本地服务；不会打开浏览器或终端。

Building from source requires Xcode Command Line Tools. The downloaded app already contains its
board runtime and does not contain the build machine's source path. It uses Codex Desktop's local
runtime when available, or a local Node.js 22+ installation as a fallback.

## Local web app / 本地网页版

### Command line / 命令行

```bash
npm run web:open
```

The default address is `http://127.0.0.1:4765`. To use another port:

```bash
CODEX_BOARD_WEB_PORT=4766 npm run web:open
```

The server listens on loopback only. Mutating requests require an in-memory random token embedded
into the served page, so unrelated websites cannot call the board API directly.

## Use inside Codex / 在 Codex 内使用

Install the public marketplace and plugin, start a new Codex task, then ask:

```bash
codex plugin marketplace add lxy1992/codex-conversation-board
codex plugin add codex-conversation-board@conversation-board
```

> 打开我的 Codex 对话看板

The rendered MCP App is the primary interface. The same state files are shared with the native and
web apps.

## Local data / 本机数据

Board state is written with mode `0600` under `~/.codex/conversation-board/`:

- `board.json` and `fast-snapshot.json` — Codex.
- `chatgpt-board.json` and `chatgpt-fast-snapshot.json` — ChatGPT.
- `claude-board.json` and `claude-fast-snapshot.json` — Claude.
- `activity.json` — Codex lifecycle cache.

Default Claude metadata locations:

- macOS Desktop: `~/Library/Application Support/Claude/claude-code-sessions/`
- Claude CLI: `~/.claude/projects/*/sessions-index.json`

Overrides for non-standard installations:

```bash
CLAUDE_DESKTOP_SESSIONS_PATH=/path/to/claude-code-sessions
CLAUDE_CLI_PROJECTS_PATH=/path/to/.claude/projects
```

The project has no analytics, telemetry, or cloud synchronization and does not send conversation
metadata to the internet. See [PRIVACY.md](PRIVACY.md) for the exact read/write scope.

## Development / 开发

```bash
npm run check
npm test
npm run release:macos
```

Browser tests use `playwright` when installed. They can also reuse a local Playwright module and
browser with `PLAYWRIGHT_MODULE_PATH` and `BROWSER_PATH`; otherwise they are skipped explicitly.

Provider-specific filesystem formats are isolated in source services. New sources should normalize
their metadata into the shared thread model instead of adding source branches throughout the UI.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md).

## Known limitations / 已知限制

- ChatGPT and Claude local catalogs do not provide the same authoritative running/unread fields as
  Codex, so those tabs deliberately show no fabricated badges.
- Claude and ChatGPT storage formats are application implementation details and may change. Parser
  failures are isolated so one unavailable source does not corrupt another board.
- The downloadable macOS app is ad-hoc signed rather than Apple-notarized.
- Windows and Linux currently use the local web app; a native installer is not provided yet.

## License

[MIT](LICENSE)
