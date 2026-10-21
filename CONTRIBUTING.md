# Contributing

Use Node 22.18+, `npm ci`, and `npm start`. The app opens a development library in
`demo/`. Never commit databases, downloaded third-party files, credentials, or model
weights. Agents (and people who like short rules) should read [AGENTS.md](AGENTS.md).

## Collections and sources

You don't need to write code to contribute. A collection is a short, chosen list of
shows, files or pages, written as one JSON file; follow
[collections/README.md](collections/README.md). To suggest a new kind of source, open
an issue: say who it helps, link to the original publishers, and include formats,
approximate sizes, language and rights.

For a bug report, include your OS and processor, app version, steps to reproduce,
and what you expected. Share a small original or openly licensed sample when
possible; remove private paths and personal information from screenshots and logs.

## Testing

| Command | What it checks |
|---|---|
| `npm test` | Core tests: imports, downloads and their failures, collections, folders and crash safety, checks, metadata, readers' parsers, path boundaries |
| `npm run check` | Every script parses |
| `npm run test:desktop` | Launches the real app in a throwaway home: import review, filters, Settings and the file check, cancelling a transfer, saving and replaying a web page |
| `npm run bench -- 50000 400` | Opens a generated library of 50,000 files and reports startup, refresh, search and scroll times |
| `npm run collections` | Checks every collection and rebuilds `collections/collections.json` |
| `node scripts/zim-smoke.js`, `node scripts/zim-security-smoke.js` | The Wikipedia reader offline, and against hostile archived HTML |

Tests should check outcomes (bytes on disk, what the catalog says, what the person
sees), not just that code ran. Use a local test server for network behavior; never
point tests at real services.

**What's verified:** Apple Silicon Macs, in development and packaged builds.

**What isn't:**
- Windows and Linux runtime; CI runs the core tests there.
- Signed installers.
- Full-size Wikipedia, split ZIM files and dynamic Zimit replay.
- Protected EPUBs, and PDF text search and forms.

## Screenshots

The README images in `docs/images/` are 1440 × 960, captured by `npm run screenshots`
from the library `npm run demo:library` builds. What's in that library, and its
licenses, is in [docs/third-party.md](docs/third-party.md).

## Source adapters and content types

Source adapters in `packages/sources` return acquisition plans with provenance.
Keep transport retries, hashing, naming, and storage in `packages/core`. Expose a
new discovery operation explicitly through `desktop/main.js` and the narrow preload
bridge. Do not add arbitrary filesystem or command execution channels.

Content handlers classify files. Add preview treatments in the renderer without
making imported content privileged. Keep unsupported formats importable and explain
their reader requirements. Never give downloaded HTML access to the desktop bridge.

## Scope

Library, Import, and Transfers are distinct workflows. Prefer simple native
integration and a small predictable UI. The library stays readable without this
application. Network sharing is planned as one opt-in server mode (see
[docs/roadmap.md](docs/roadmap.md)); don't add other servers or sharing paths.

Document platform and offline limitations. CI configuration is not evidence that
platform builds ran.
