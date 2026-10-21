# Collections

A collection is a list of things worth keeping, chosen by a person: one JSON file in
`collections/`, reviewed in a pull request. It never brings its own download code;
every entry is something an existing importer already fetches. The format, types and
contribution rules are in [collections/README.md](../collections/README.md). This page
is how the system works.

## Life of a collection

1. **Written.** A contributor writes `collections/<type>/<id>.json`, then runs
   `npm run collections -- --fill <file>`. That downloads each new file once, checks
   it's the right kind of file, and writes in its size and checksum.
2. **Merged.** `npm run collections` checks everything and rebuilds
   `collections/collections.json`, the one file the app reads, which is committed with
   it. CI fails if it's out of date.
3. **Published.** The app reads that file from the repository's main branch, at most
   once a day, with a conditional request. Each release ships a copy for first launch
   and offline use, and the newer of the two wins. A collection removed from main
   disappears from every app within a day; nothing already saved is touched.
4. **Saved.** Someone opens a collection, unticks what they don't want and saves. Each
   entry becomes its importer's usual plan:
   - **files:** a direct download with a pinned checksum
   - **websites:** a web page plan, one per date (the closest Wayback copy, or today's
     page)
   - **podcasts:** there's one list, of recommended shows, shown at the bottom of the
     Podcasts page. Nothing downloads; each show opens there to pick episodes. It isn't
     a collection card anywhere else.
5. **Kept up.** A weekly CI job asks for every address once and opens an issue for
   anything broken. A maintainer fixes or removes it.

## In the app

- **Where collections show up:** four featured collections, picked at random each
  launch, below the types on Add content's front page; each importer's own collections
  at the bottom of its page, featured first; and **See all**, with search and topic
  filters, which is how a type with dozens of collections is browsed.
- **Offline,** each collections space says "You're offline" instead, since saving needs
  the internet. The app uses the system's own online signal, so this costs nothing, and
  collections come back when the connection does.
- **Covers** are drawn per type, not downloaded, so they cost nothing and work offline.
- **A collection's page:** the summary, who chose it, its size, and every entry with a
  checkbox and its state: Saved, a percentage, Server busy, Refused, Gone from source,
  or New. One main button changes with the situation: **Save all · 12.4 GB**,
  **Save 3**, or **Resume 5**.
- **Transfers** shows one row per collection ("42 of 300 saved"), with Pause, Resume
  and Cancel, and opens to show its files.

## Saving

- **Space** is checked for the whole selection before anything starts.
- **Folder:** files go into a folder named after the collection, inside the default
  folder for its type (`Images`, `Documents/Books`), found by name and made if it's
  missing. A renamed folder isn't followed, since it may mean something else now. Once
  made, the collection's own folder records `collection:<id>`, so it keeps receiving
  that collection's files wherever it's moved or however it's renamed.
- **Details:** each file's `item.json` records the collection, entry, curator, original
  page and rights.
- **New entries:** once someone has saved from a collection, entries added later show
  as **New**, and its card says "3 new". What's been seen is kept in
  `.obelisk/collections.json`.
- **What's ticked:** everything not in the library, including files deleted earlier.
  Nothing about unticked entries is remembered.
- **Saving again** only fetches what's missing.

## When servers push back

Failures are sorted by what can be done about them, in
`packages/core/transfer-errors.js`.

| What happened | Kind | What Obelisk does | What people see |
|---|---|---|---|
| Asked to slow down (429, or 503 with Retry-After) | busy | Waits at least as long as asked, longer each time it repeats (up to 15 minutes), then carries on by itself. Everything from that server waits. Gives up after 8 tries. | "… asked Obelisk to slow down. Continuing at 5:01 PM." |
| Connection failed, timed out or ended early; a passing server fault (5xx) | offline | Retries after 10 s, 20 s, 40 s…, up to 5 tries, resuming where the file stopped if it can. | "Couldn't reach … Trying again by itself." |
| Refused (401, 403), or a web page instead of the file | refused | No retry. After 3 refusals in a row from one server, the collection's other files from it pause. | "… is refusing downloads (3 files turned away), so the others are paused." |
| Gone (404, 410) | gone | Asked once, never again. | "1 file can't be saved: no longer at the source." |
| Not the file described (checksum, size, or the wrong kind of file) | changed | Nothing saved; never retried. | "… changed at the source since this collection was made." |
| Disk full | space | Everything pauses. | "Free some space, then resume." |

**Stopping halfway** (an error, or Obelisk being closed) loses nothing:
- Saved files stay saved.
- **Resume** carries on with what's left, using the collection's current links.
- Files that are gone or changed are listed, not retried.

## Being a good guest

One click can mean thousands of people each fetching hundreds of files from one
museum.
- **Per collection:** 2 files at a time by default, 1 for video, at most 4 (`parallel`
  in the collection).
- **Per server:** at most 3 at once, with a second between starting two downloads.
  Servers with their own guidance get fewer: 1 for Wikimedia, Project Gutenberg and
  Standard Ebooks, 2 for the Internet Archive.
- **How requests go out:** every request names Obelisk. Collection files come through
  the app's browser connection, because some servers (the Art Institute of Chicago's,
  for one) refuse requests that look like a script.
- **The fill command** waits 3 seconds between requests to a server, and at least a
  minute when told to slow down.

## Where it lives

| Path | What |
|---|---|
| `packages/collections/format.js` | The format, the check, recognizing files by their first bytes |
| `packages/collections/plans.js` | Entries as importer plans |
| `packages/collections/source.js` | The shipped, cached and published lists |
| `packages/core/downloads.js` | Lanes, server limits, spacing, retries, refusals, grouped actions |
| `packages/core/library.js` | Saving, folders, status, remembered deletions |
| `desktop/renderer/collections.js` | Cards, browsing, the collection page |
| `scripts/collections.js` | `npm run collections` (`--fill`, `--online`, `--verify`) |
| `.github/workflows/collections.yml` | The weekly link check |

The published address is `obelisk.collections` in `package.json`, set once the
repository is public. Until then the app uses its shipped copy.
