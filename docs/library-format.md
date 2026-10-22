# Library format

A library is an ordinary folder. Everything in it can be read without Obelisk, and
another copy of Obelisk can open it after it's copied to another drive.

## On disk

```text
My Library/
  ABOUT THIS ARCHIVE.txt     a guide for people who open the folder by hand
  .obelisk/                  app state: library.json, catalog, thumbnails, journal
  Inbox/                     folder.json
  Audio/                     folder.json
    Music/                   folder.json
      Kind of Blue/          folder.json
        So What--3f2a91c0/   item folder
          So What.flac
          item.json
    Podcasts/                folder.json
      The Daily/             folder.json  (records its feed)
        Episode 12--…/
```

Every directory under the root is exactly one of:

| Directory | Contains | Meaning |
|---|---|---|
| Folder | `folder.json` | Something people organize with. Holds folders and item folders. |
| Item folder | `item.json` | One file and its metadata. Never holds folders. |
| Neither | — | Made outside the app. Treated as a folder; `folder.json` is written the first time it changes. |

- **Where an item is:** wherever its item folder is. The `path` in `item.json` is a
  hint for older versions and is never used to find the file.
- **Moving:** moving a file moves its item folder, and moving a folder renames one
  directory.
- **Packages:** packages macOS shows as one file (`.pages`, folder-based EPUBs) are
  zipped into one standard file on import.
- **The catalog** (SQLite, in `.obelisk/`) is derived. It rebuilds from the
  `item.json` and `folder.json` files at any time.

### Directory names

A directory's name follows the display name as closely as every platform allows:
`/ \ : * ? " < > |` and control characters become `-`, leading and trailing dots and
spaces go, Windows reserved names (`CON`, `NUL`…) get a trailing `-`, and names stop
at 80 characters. A sibling with the same name, ignoring case, gets ` 2`, ` 3`. New
item folders end in `--` and 8 characters of the item's ID.

## folder.json

```json
{ "schemaVersion": 1, "id": "b1e4…", "name": "Kind of Blue", "icon": "album", "position": 2, "source": { "key": "podcast:12345" } }
```

- **`id`:** stable for the life of the folder; importers refer to it.
- **`name`:** the display name, any characters.
- **`icon`:** a bundled icon name.
- **`position`:** where it was dragged among its siblings. Folders without one sort by
  name after those with one.
- **`source.key`:** on folders made for a group, like a podcast show or a collection,
  so the group finds its folder wherever it's moved.

## library.json

`.obelisk/library.json` belongs to the library and travels with it:

```json
{
  "schemaVersion": 1,
  "inbox": "<folder id>",
  "destinations": { "web": "<id>", "podcasts": "<id>", "files:image": "<id>", "…": "…" },
  "defaultsCreated": true
}
```

- **`destinations`:** each importer's **Save to** folder, by ID.
- **`defaultsCreated`:** stops deleted default folders from coming back.

Also in `.obelisk/`:
- **`journal.json`:** the plan for a multi-step move while it runs.
- **`collections.json`:** which collection entries this library has been shown, and
  which were deleted on purpose.
- **`thumbnails/`:** covers and waveforms. Keep it to keep custom covers; the rest
  regenerates.

## item.json

An import writes the file, then its `item.json` (through a temporary file), then the
catalog. If the manifest can't be written, the file goes back and nothing is saved; a
file left without one after a crash shows up in Check archive, ready to add again.

Every manifest has:
- `schemaVersion: 1`, a stable `id`, `title`, `description`, `filename`, `path`
- `bytes`, `sha256`, `acquiredAt`
- `source`: where it came from
- `rights`
- `integrity`: `publisher-verified` when the bytes matched a size and checksum given
  in advance, otherwise `hashed`

Optional fields appear only when set:
- `tags` (lowercase), `favorite`, `rating` (0–5)
- `creator`, and `created`: free text for the date of the original, like `1969-07-20`
  or `c. 1850`
- `originalMetadata`: the replaced values, saved the first time a person edits title,
  description, creator, created or rights. `metadataUpdatedAt` records the latest edit.

**Dates filled in by themselves.** `created` is filled in on import when it's known,
either from the file or from its source:
- **From the file:** EXIF, MP4/MOV headers, ID3, PDF, EPUB and Office metadata.
- **From the source:** a Wayback capture date, an OpenStreetMap build, a podcast's
  publish date, a video's upload date, a Wikipedia edition.

**`source`.** Records the importer and the original address. Some sources add more:
- Editions and episodes add `seriesKey` and `version`.
- Saved web pages add `capturedAt`, `capturedFrom` (`live` or `wayback`) and the
  Wayback `snapshot`.
- Collection files add `collection`: the collection's ID, title and curator, and the
  entry.

**Legacy fields.** `type` and `kind` are older fields. They're still read and written
so older versions can open the library, but where a file lives comes from its folder,
and how it opens comes from its format (the table in `packages/types/index.js`).

## Saved web pages (WACZ)

A saved page is one `.wacz` file: a ZIP, stored without compression, holding:
- `archive/data.warc.gz`: WARC 1.1, one gzip member per record
- `indexes/index.cdx`: CDXJ, where each response sits
- `pages/pages.jsonl`: address, title, capture time and the page's text
- `datapackage.json`

Bodies are stored decoded, without `Set-Cookie`. The screenshot is a `resource`
record named `urn:thumbnail:<address>`.

## Checks

**Settings → Check files** compares the library with its manifests. It records each
file's `fileState` and the hash and size it observed:
- **Moved:** the manifest is updated.
- **Edited:** the file keeps its original checksum. **Accept current file** keeps up to
  20 earlier checksums, as history, not a backup.
- **Missing:** stays listed. Nothing is dropped or deleted.

Limits: checks skip symlinks and app bundles, and stop at 5 million entries or 20
levels deep.

**Files added by other means.** Files dropped into the folder in Finder or by sync
have no manifest. A check reports them as not in the library. **Add to library**
gives each one its own item folder and manifest, and removes the original only if it
hasn't changed in the meantime.

**Software.** Software items also record platform, architecture, requirements and a
user-confirmed offline test. A check clears that test if the file has changed.

## Default folders for a new library

| Folder | Subfolders | Default Save to for |
|---|---|---|
| Inbox | | transfers whose folder is gone |
| Documents | Books | documents |
| Audio | Music, Podcasts, Audiobooks | audio files; podcasts go to Podcasts |
| Video | | video |
| Images | Photos | images |
| Maps | | maps |
| Reference | Wikipedia, Websites | Wikipedia, web pages |
| Software | | software |
| Backups | | nothing; a place for copies of important documents and things kept in the cloud |
| Other | | anything else |

All of them can be renamed, moved, re-iconed or deleted.

**Older libraries.** Libraries from before folders open with nothing moved: their
shelf folders get a `folder.json`, and libraries from before the rename have
`.alexandria/` renamed to `.obelisk/`.
