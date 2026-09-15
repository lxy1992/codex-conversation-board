# Privacy

AI Conversation Board is local-first software. It has no analytics, telemetry, advertising,
account system, or cloud synchronization.

The app reads only the local metadata needed to build the board: titles, identifiers, timestamps,
project paths, branches, lifecycle state, and Codex's native read/unread state. It does not read
ChatGPT or Claude message bodies.

Board configuration, card ordering, and lightweight caches are stored under
`~/.codex/conversation-board/` with user-only permissions. The standalone service listens only on
`127.0.0.1` and does not upload conversation metadata.

See the plugin's [detailed privacy document](plugins/codex-conversation-board/PRIVACY.md).
