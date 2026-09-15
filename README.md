<p align="center">
  <img src="plugins/codex-conversation-board/assets/icon.svg" width="112" alt="AI Conversation Board icon">
</p>

# AI Conversation Board / AI 对话看板

A local-first kanban board for **Codex tasks**, **ChatGPT chats synced into Codex**, and
**Claude Code sessions**. Use it as a Codex MCP App, a native macOS window, or a local web app.

本地优先的 AI 对话看板：用独立页签整理 **Codex 任务**、**ChatGPT 对话**和
**Claude Code 会话**。支持 Codex 插件、macOS 独立窗口和本地网页版三种形式。

## Download / 下载

[**Download the latest macOS release / 下载最新版 macOS 安装包**](https://github.com/lxy1992/codex-conversation-board/releases/latest)

Open the DMG and drag **AI 对话看板** to Applications. The universal package supports Apple
Silicon and Intel Macs running macOS 13 or newer. It is ad-hoc signed but not Apple-notarized, so
the first launch may require right-clicking the app and choosing **Open**.

打开 DMG，把 **AI 对话看板** 拖入“应用程序”即可。安装包同时支持 Apple Silicon 和 Intel
Mac，要求 macOS 13 或更高版本。首次启动如果被系统拦截，请右键 App 并选择“打开”。

## Install in Codex / 安装 Codex 插件

```bash
codex plugin marketplace add lxy1992/codex-conversation-board
codex plugin add codex-conversation-board@conversation-board
```

Start a new Codex task and ask: `打开我的 Codex 对话看板`.

## Features / 功能

- Separate Codex, ChatGPT, and Claude tabs with independent board state.
- Configurable status names, colors, descriptions, and lane order.
- Drag cards or use the per-card **Move to…** menu.
- Running and unread badges use Codex's native local state instead of timestamp guesses.
- Renamed conversation titles synchronize automatically on the lightweight card refresh.
- The Done lane initially shows today's completed conversations; history loads on demand.
- Completed catalog-backed conversations return to Inbox after new local activity.
- Clicking a card opens the matching conversation in Codex or Claude Desktop.

默认包含收件箱、待处理、进行中、阻塞、待验收、完成六个泳道。每个来源都可以单独新增、
改名、换色、删除状态并调整顺序；“完成”列默认只载入今天完成的内容。

## Supported sources / 数据源

| Source | Local data | Open behavior | Running / unread |
| --- | --- | --- | --- |
| Codex | Codex App Server metadata | Opens the Codex task | Supported |
| ChatGPT | Codex Desktop local ChatGPT catalog | Opens the chat inside Codex | Catalog does not expose it |
| Claude | Claude Desktop Code metadata and CLI indexes | Continues the Claude Code session | Not exposed reliably |

Claude support covers **Claude Code sessions**, not ordinary cloud chats on `claude.ai`. The board
reads metadata only and does not read Claude or ChatGPT message bodies.

## Privacy / 隐私

- No analytics, telemetry, advertising, account system, or cloud synchronization.
- The web service listens only on `127.0.0.1`.
- Board configuration and lightweight caches stay under `~/.codex/conversation-board/` with
  user-only permissions.
- Real conversation titles, transcripts, account IDs, local state, and private paths are not part
  of this repository or release package.

See [PRIVACY.md](PRIVACY.md) for the exact local read/write scope.

## Development / 开发

```bash
cd plugins/codex-conversation-board
npm run check
npm test
npm run release:macos
```

The plugin itself lives in [`plugins/codex-conversation-board`](plugins/codex-conversation-board).
See its [full documentation](plugins/codex-conversation-board/README.md) and
[contribution guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
