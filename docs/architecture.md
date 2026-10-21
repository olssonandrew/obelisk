# Architecture

Obelisk is one Electron main process and a sandboxed renderer. Files stay ordinary and
manifests keep relative paths, so the interface could be replaced without changing the
library format ([library-format.md](library-format.md)).

## Processes and the bridge

- **Main process** (`desktop/main.js`): owns the open library
  (`packages/core/library.js`) and does all networking.
- **Renderer** (`desktop/renderer`): reaches the main process only through the
  context-isolated bridge in `desktop/preload.cjs`. That's a fixed list of named
  calls: state, importing, transfers, folders, collections, reveal and open. There are
  no generic file, shell or command calls. IPC checks that the sender is the app's own
  top-level frame.
- **Files:** served by the `obelisk:` protocol, by catalog ID, never by a path the
  renderer supplies. Real paths must stay inside the library. Byte ranges support media
  seeking and map tiles. Archived active content gets a restrictive CSP.
- **Navigation:** external navigation, new windows, webviews and permission requests
  are denied. A short allowlist of publisher sites opens in the system browser.
  Installers and scripts are revealed in Finder, never run.
- **No network service.** Server mode is planned ([roadmap.md](roadmap.md)).

**Updates to the window.** The renderer doesn't poll. Every catalog write, a change in
free space, and the start and end of a check send `library:changed`, at most once per
150 ms. The renderer then asks for state with the revision it holds, and gets the item
list only if that changed. The grid draws only the rows near the viewport.

## The library pipeline

`library.js` opens the catalog, rebuilds it from manifests in the background, and
joins the importers to one pipeline:
1. **Sources** (`packages/sources`) turn what someone asked for into plans.
2. **Transfer drivers** produce files: HTTP, PMTiles extraction, web capture and video.
3. **Every file** then goes through the same naming, hashing, provenance and placement
   into its folder (`packages/core/archive.js`).

**The download queue** (`packages/core/downloads.js`):
- Downloads resume when the server supports it.
- Each server has a limit, with spacing between starts.
- Failures are sorted by kind (busy, offline, refused, gone, changed, space). Busy and
  offline retry by themselves; the others stop and say why.
- Collection downloads run in their own lanes.

See [collections.md](collections.md) for the full behavior.

**Metadata and folders.**
- `metadata.js` serializes manifest writes: each replacement is atomic, though a batch
  across many files isn't a transaction.
- Tags (`tags.js`) are lowercase strings in `item.json`.
- Folders, Save to destinations and the move journal are in `folders.js`
  ([folders.md](folders.md)).
- Removal goes through `library.removeItems(ids, dispose)`. Core never unlinks; the
  desktop passes the system Trash.

## Readers

| Format | How it opens |
|---|---|
| Images, audio, video, text, Markdown | Built in. Markdown and text are sanitized and never run anything. |
| PDF, EPUB | Bundled readers with page and chapter navigation. EPUB strips publisher CSS and active content. Both are basic; better reading is on the roadmap. |
| Wikipedia and other ZIMs | The OpenZIM WebAssembly reader, below. |
| Maps (PMTiles) | MapLibre, below. |
| Saved web pages (WACZ) | Isolated replay, below. |

**Thumbnails** are made lazily, two at a time:
- **Sources:** video frames, EPUB covers, PDF first pages and MP3 artwork. Nothing is
  fetched from the internet.
- **Waveforms:** audio without artwork gets a waveform of 80 loudness readings, read by
  FFmpeg when it's installed (`desktop/waveform.js`), otherwise by Web Audio for small
  files. It's drawn as one SVG path that's also the player's scrubber.
- **Storage:** covers are JPEGs in `.obelisk/thumbnails`, keyed by item ID and content
  hash. Custom covers live there too.

**ZIM reader** (`desktop/zim`):
- **Engine:** one lazy worker runs the pinned OpenZIM javascript-libzim build. It reads
  files on demand without copying them into memory, handles lookups, redirects, title
  suggestions and full-text search, and times out after 30 seconds.
- **Access:** `service.js` gives one active reader a random token; stale tokens fail
  closed.
- **Display:** articles show in a sanitized, script-free frame under a strict CSP,
  with history kept by the outer frame.
- **Not supported:** split `.zimaa` sets, scripts, dynamic Zimit replay, cross-archive
  search, and very large single entries.

**Maps** (`desktop/map`):
- **The viewer is an atlas.** It reads each saved PMTiles header for its bounds, loads
  up to eight nearby maps as vector sources, and fogs everything outside the saved
  areas over a bundled world outline.
- **Styling:** layers come from `@protomaps/basemaps`. Labels use the system font, so
  no font files are needed.
- **The area chooser** shows OpenStreetMap preview tiles (visible tiles only, with
  attribution) under a frame you can move and resize. `measureMap` gives the exact
  download size from a dry run of the extractor. The download itself is a Protomaps
  regional extract, not the preview tiles.

**Web pages** (`desktop/web-archive.js`, `packages/core/wacz.js`,
`packages/sources/web.js`):
- **Capture:**
  - The page loads in a hidden, sandboxed window on a throwaway session whose handlers
    record every response.
  - Wayback copies are fetched from `web.archive.org/web/<timestamp>id_/<url>`, so the
    original bytes load at the original address.
  - Pages are scrolled for lazy images, and a screenshot is stored.
  - Limits: 40 MB per response, 400 MB and 3,000 responses per page.
- **Finding Wayback copies:** asking for any timestamp redirects to the nearest
  capture. That's faster and more complete than the availability API. Lookups go
  through Electron's network stack, which reuses one connection the Archive accepts,
  250 ms apart.
- **Replay:** a second throwaway session answers only from the WACZ, with networking
  emulated offline and a dead proxy. The page runs in its own view with no preload,
  permissions, downloads or popups.

**Video downloads** (`packages/core/video-tools.js`):
- **Tools:** the first use installs official yt-dlp, FFmpeg and FFprobe builds into the
  app's own data folder, checked against the publishers' checksums. They aren't
  bundled with the app.
- **Limits:** no credentials, cookies, arbitrary arguments, live streams or DRM
  bypass. Sites change and can break downloads.

## The interface

`app.js` owns selection, filtering, the viewer and keyboard handling. Separate
modules hold:
- the details pane (`inspector.js`)
- folders (`folders.js`), import (`importer.js`, `discover.js`) and collections
  (`collections.js`)
- tags, icons and thumbnails

The details pane saves when a field loses focus, and isn't redrawn while a field has
focus. Colors are CSS custom properties in `style.css`, switched by `data-theme`.

The interaction model borrows from Eagle (https://eagle.cool/): a gallery, a
persistent inspector, quick filters, ratings, space to preview, batch actions.
