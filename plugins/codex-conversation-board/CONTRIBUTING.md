# Contributing

## Development setup

1. Install Node.js 22 or newer.
2. Run `npm run check`.
3. Run `npm test`.

Browser tests are optional when Playwright or Chromium is unavailable. Set
`PLAYWRIGHT_MODULE_PATH` and `BROWSER_PATH` to use non-standard installations.

## Source adapter rules

- Keep source-specific filesystem parsing and navigation inside its service.
- Normalize every source to the shared thread shape consumed by `server/server.mjs` and the UI.
- Never read message bodies when metadata is sufficient.
- Do not infer running or unread state from timestamps alone.
- Add sanitized fixtures for malformed, missing, archived, duplicate, and newly updated sessions.
- Never commit real conversation titles, account IDs, paths, transcripts, or board state.

## Pull requests

- Explain the user-visible behavior and the local data touched.
- Include unit tests; include a browser test when UI behavior changes.
- Confirm `npm run check` and `npm test` results.
