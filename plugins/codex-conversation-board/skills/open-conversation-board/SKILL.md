---
name: open-conversation-board
description: Open the interactive Codex, ChatGPT, and Claude Code conversation kanban board inside Codex. Use when the user asks for the conversation board, status board, kanban, project status view, or wants to organize Codex tasks, ChatGPT chats, or Claude Code sessions by status.
---

# Open Codex Conversation Board

Call the `show_board` tool from the `conversationBoard` MCP server exactly once.

- Let the returned UI be the primary answer; do not enumerate or summarize every conversation.
- Open only the returned MCP App. Never use `open_in_codex`, a Browser tab, `file://`, localhost, or an exported `board.html` as the user-facing board.
- The board status is user-owned and independent from Codex runtime status.
- Use `get_board`, `move_thread`, and `open_thread` only through the rendered app unless explicitly text-only.
- If the UI cannot render, report the small summary and suggest opening it in a new Codex task.
