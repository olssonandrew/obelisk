# Roadmap

What's built, what's next, and what's only an idea. Statuses are kept current with the
code.

**Status:** ✅ done · 🔨 in progress · 📋 planned · 💡 idea

# Features

## Library

| Feature | Status | Notes |
|---|---|---|
| Plain-file library: each file in its own folder with an `item.json` | ✅ | [library-format.md](library-format.md) |
| Catalog rebuilt from the files at any time | ✅ | |
| Folders: tree, drag and drop, reorder, move up, delete (keep or Trash) | ✅ | [folders.md](folders.md) |
| Tags, ratings, dates, notes, search | ✅ | |
| Integrity check: missing, moved, changed and untracked files | ✅ | |
| Crash-safe moves (journal, undo on failure, retry on next open) | ✅ | |
| Warning when a library is in iCloud, Dropbox, OneDrive and similar | ✅ | |

## Importing

| Feature | Status | Notes |
|---|---|---|
| Files and folders from this computer, with review before import | ✅ | |
| Web pages, live or from the Wayback Machine (WACZ) | ✅ | |
| Wikipedia and other Kiwix editions, read in the app | ✅ | [architecture.md](architecture.md#readers) |
| Wikipedia page: just the full encyclopedia, with and without images | 📋 | Topic editions stay listed from Kiwix; not contributable. |
| Offline maps of any area, with a resizable frame | ✅ | |
| Podcasts: search, follow, save episodes | ✅ | Browse all feed episodes in pages of 100; selections carry across pages. |
| Video from a link | ✅ | [architecture.md](architecture.md#readers) |
| Software and AI models | ✅ | |
| Downloads: resume, retries, rate limits, polite per-server limits | ✅ | [collections.md](collections.md#when-servers-push-back) |

## Collections

| Feature | Status | Notes |
|---|---|---|
| Collections v1: podcasts, websites, books, documents, images, music, audiobooks, video | ✅ | [collections.md](collections.md) |
| Collection browsing within importers | ✅ | Up to 12 random collections per section; See all for longer lists. Featured picks stay on the homepage. |
| Contributor guide, `npm run collections` check and fill, weekly link check | ✅ | [collections/README.md](../collections/README.md) |
| Live list from the repository | 🔨 | Set `obelisk.collections` in `package.json` once the repo is public. |
| More starter collections, and a robustness pass | 🔨 | |
| Software list as collections, one entry per platform | 💡 | |

## Server mode

| Feature | Status | Notes |
|---|---|---|
| Share the library on the local network: anyone on the same Wi-Fi opens it in a browser | 📋 | Runs on the Mac that holds the drive. Off by default. |
| Settings: on or off, read-only or not, a password, which folders are shared, port | 📋 | |
| Browser reader for each kind of file: pages, books, maps, Wikipedia, media | 📋 | Reuses the app's readers where it can. |

## Builds and CI

| Feature | Status | Notes |
|---|---|---|
| PMTiles license notice | ✅ | Kept in [third-party.md](third-party.md#pmtiles-license); the build emits its standalone vendor notice. |
| Tests on Mac, Windows and Linux for every push | ✅ | Configured; has never run, as there's no remote yet. |
| Release builds for Mac, Windows and Linux from CI, on a version tag | 🔨 | `npm run release -- <version> --push`; see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing). Configured and the Mac build checked locally; the workflow hasn't run yet. |
| Mac builds open with Open Anyway, not as damaged | ✅ | Ad-hoc signed by `npm run package`. |
| Smaller builds: only runtime files and dependencies | ✅ | |
| Mac signing and notarization | 💡 | Needs an Apple Developer account. |

## First public release

| Item | Status | Notes |
|---|---|---|
| Public GitHub repository and first commit | 📋 | |
| User agent with the project's address (Wikimedia asks for a contact) | 🔨 | One agent for every request, with the version; set `homepage` in `package.json` to the repo URL. |
| README screenshots retaken, including collections | ✅ | |
| README download button | ✅ | Links to the latest release. A star count is ready in a comment for when the repo is public. |
| Fresh-clone check: `npm ci`, tests, launch | ✅ | |
| First CI run, and fixes from it | 📋 | Expect some on Windows. |
| GPL source for the bundled Wikipedia reader, published with builds | ✅ | Attached to each release; see [third-party.md](third-party.md). |

# Fixes

| Fix | Status | Notes |
|---|---|---|
| Sidebar folder clicks reveal subfolders | ✅ | Clicking opens the folder and expands its sidebar branch; the arrow still collapses it. |
| Show subfolders switch alignment | ✅ | Thumb stays centered in both positions, independent of general input styling. |
| Better EPUB and PDF reading | 📋 | EPUB cover wrappers retain their images, empty sections explain themselves, and bookmark styling, EPUB 2/3 chapter labels, encoded footnotes and arrow-key navigation are fixed. Still planned: search, remembering your place, richer layout and PDF navigation. |
| Large libraries | 📋 | Startup, search and scrolling are benchmarked at 50,000 files (`npm run bench`); moves and checks at that size aren't yet, and some moves scan the whole catalog. |
| Imports and folder moves refuse folders replaced by links outside the library | ✅ | |
| Moving a changed Mac package into the library keeps the original | ✅ | Every file inside is compared, not totals. |
| A failed `item.json` write saves nothing | ✅ | |
| A recovery move whose destination is taken stays unfinished | ✅ | |
| The app copy is saved after the window opens, and not into the demo | ✅ | First launch opens in about 2.5 s instead of 13. |
| Windows and Linux rough edges | 💡 | Expected once people use them; tested only in CI so far. |
