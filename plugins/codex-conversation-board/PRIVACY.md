# Privacy

AI Conversation Board is local-first software. It has no analytics, telemetry, advertising,
account system, or cloud synchronization.

## Data the app reads

- Codex task metadata exposed by the local Codex App Server.
- The local Codex Desktop catalog used for Codex title updates and ChatGPT metadata.
- Claude Code session metadata from Claude Desktop and Claude CLI indexes.
- Codex's local read/unread state.

The app reads titles, identifiers, timestamps, project paths, branches, and lifecycle metadata that
are needed to build the board. It does not read ChatGPT or Claude message bodies.

## Data the app writes

Board configuration, card order, and lightweight cache files are stored with user-only permissions
under `~/.codex/conversation-board/`.

## Network behavior

The standalone app serves its UI on `127.0.0.1` only. It does not send conversation metadata to the
internet. The project contains no analytics or remote API client. GitHub is contacted only when the
user chooses to download or update the software outside the app.

## Removing local data

Uninstalling the app does not delete board state. Delete `~/.codex/conversation-board/` manually if
you also want to remove saved lane assignments and caches.
