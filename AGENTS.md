# AGENTS.md

Obelisk: an Electron app (Node 22.18+, ES modules) that downloads, organizes and opens a
personal offline library.

## Commands

```sh
npm ci                                        # install; also runs npm run build
npm start                                     # run against the demo library in demo/
npm test                                      # all core tests
node --test tests/folders.test.js             # one file
node --test --test-name-pattern="rename" tests/folders.test.js   # one test
npm run check                                 # every script parses
npm run test:desktop                          # launches the real app; run after UI changes
npm run collections                           # after editing collections/; rebuilds collections.json
```

## Rules

1. **The library is plain files.** Each item is a folder holding the file and its
   `item.json`. The SQLite catalog is derived and must rebuild from those files.
   Never store anything only in the catalog.
2. **Never destroy a person's files.** Removal goes through a `dispose` callback (the
   system Trash). The only other deletion is finishing a move into the library, after
   checking the original hasn't changed. Nothing may be written or moved outside the
   library root; check real paths, symlinks included.
3. **Write state atomically.** JSON goes through `writeJson` (temporary file, then
   rename). Anything that renames more than once goes through `run()` in
   `packages/core/folders.js`, which journals it and undoes it on failure.
4. **The renderer stays sandboxed.** Add a capability as one named `handle(...)` in
   `desktop/main.js` plus one line in `desktop/preload.cjs`, and validate its arguments
   in main. Files are addressed by catalog ID, never by a path from the renderer.
   Downloaded content never gets the bridge.
5. **Network politely.** Downloads go through the queue in
   `packages/core/downloads.js`, which applies per-server limits and backoff. Tests use
   a local server, never real sites. Scripts that touch real services go one request at
   a time, with pauses.
6. **Don't edit generated files:**
   - `desktop/map/vendor/`, `desktop/renderer/reader/vendor/` and
     `desktop/renderer/zim/reader.bundle.js` come from `npm run build`. Rerun it after
     changing `desktop/renderer/thumbnail-renderer.js`,
     `desktop/renderer/reader/reader.js` or `desktop/renderer/zim/reader.js`.
   - `collections/collections.json` comes from `npm run collections`.
7. **Interface words are plain and said once.** No hedging, no slogans, no repeating
   the heading in the text.
8. **Folders are found by default name, not tracked through renames,** when the app
   picks a place on its own (collections, the Add content button). Only a folder a person
   chose (Save to) or a group's own folder (a podcast show, a collection) is followed by
   ID.

## Gotchas

- **The app runs one copy per home folder.** To run beside an open copy, set
  `OBELISK_HOME` to another folder.
- **`demo/` is local and git-ignored.** Don't commit it, `dist/`, downloads or
  credentials.
- **New dependencies** need a clear reason; most things already have a helper in
  `packages/core`.

## Done means

- `npm test` and `npm run check` pass.
- New behavior has a test that checks the outcome (files on disk, catalog, what the
  person sees).
- UI changes are run with `npm run test:desktop`, and looked at.
- Docs that describe the change, and [docs/roadmap.md](docs/roadmap.md) statuses, are
  updated in the same change.

## More

[docs/architecture.md](docs/architecture.md) · [docs/library-format.md](docs/library-format.md) ·
[docs/folders.md](docs/folders.md) · [docs/collections.md](docs/collections.md) ·
[docs/third-party.md](docs/third-party.md) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[collections/README.md](collections/README.md)
