# Changelog

## 0.8.1 - 2026-09-15

- Synchronize renamed conversation titles on the existing lightweight activity refresh.
- Read only the visible Codex cards' title metadata in one local SQLite batch.

## 0.8.0 - 2026-09-15

- Prepare the first public, privacy-reviewed source release.
- Bundle the board runtime inside the macOS app instead of embedding the build machine's source path.
- Add a universal macOS DMG release builder for Apple Silicon and Intel.

## 0.7.1 - 2026-09-15

- Replace the single 32px macOS icon with a complete 16px-1024px Retina icon set.

## 0.7.0 - 2026-09-15

- Add per-source settings for status names, descriptions, colors, and lane order.
- Support custom statuses while preserving Inbox and Done system behavior.
- Safely migrate cards when a user removes a status.

## 0.6.1 - 2026-09-15

- Keep the source tabs anchored while provider-specific header subtitles change.

## 0.6.0 - 2026-09-15

- Upgrade the macOS launcher into a signed native AppKit/WebKit window.
- Keep the local loopback service and shared board state while no longer opening a browser.

## 0.5.0 - 2026-09-15

- Add a macOS one-click app launcher that silently starts the local web service when needed.
- Make `npm run web:open` reuse an existing service instead of failing on an occupied port.

## 0.4.1 - 2026-09-15

- Automatically load Claude history when a small board contains only completed sessions, avoiding an apparently empty tab.

## 0.4.0 - 2026-09-14

- Add a separate Claude tab for Claude Desktop Code sessions and Claude CLI history.
- Continue Claude sessions through allow-listed `claude://` deep links.
- Give Claude its own board state and fast snapshot.
- Share catalog-backed board logic across ChatGPT and Claude sources.
- Add portable browser-test discovery and initial open-source project documents.

## 0.3.3

- Distinguish active Codex turns from unread completed replies.
- Reopen completed conversations after new replies.
- Default the Done lane to today's completed conversations.
