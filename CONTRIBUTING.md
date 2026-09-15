# Contributing

## Development setup

1. Install Node.js 22 or newer.
2. Enter `plugins/codex-conversation-board`.
3. Run `npm run check` and `npm test`.

Browser tests are optional locally when Playwright or Chromium is unavailable. CI installs both and
runs the complete suite.

## Privacy and source adapters

- Never commit real conversation titles, account IDs, local paths, transcripts, board state, or
  credentials.
- Keep source-specific filesystem parsing and navigation inside its service.
- Never read message bodies when metadata is sufficient.
- Do not infer running or unread state from timestamps alone.
- Add synthetic fixtures for malformed, missing, archived, duplicate, and updated sessions.

## Pull requests

- Explain the user-visible behavior and local data touched.
- Include unit tests and a browser test when UI behavior changes.
- Confirm `npm run check` and `npm test` pass.
