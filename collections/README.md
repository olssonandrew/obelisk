# Adding a collection

Collections appear on Obelisk's Add content page and on each importer's page. People save
a whole one, or just the parts they want. How it works is in
[docs/collections.md](../docs/collections.md).

This guide is meant for people and for agents working on their behalf. Follow it
exactly. A pull request that does gets reviewed fastest.

## What makes a good collection

- **Someone chose it.** You'd tell a friend it's worth keeping. "Everything by X" or
  "every issue ever uploaded" isn't a collection.
- **One subject.** If you can't describe it in one sentence, split it.
- **Worth having in full.** Someone who saves the whole thing shouldn't regret any
  of it.
- **Public sources.** Everything is freely available from its publisher, with no
  login. Record the rights each source states, so people know what they're keeping.
- **A good guest.** The source allows ordinary downloads. Project Gutenberg asks
  programs to use its mirrors. Standard Ebooks keeps bulk downloads for paying
  patrons, so keep a list from them short.
- **Not already covered.** Look through `collections/` first. If one on your subject
  exists, improve it instead.

These get declined:
- bulk dumps
- copies rehosted somewhere new
- anything behind a login or paywall, or against a site's terms
- affiliate or tracking links
- software of any kind
- near-duplicates of an existing collection

## Where files go

```text
collections/
  <type>/
    <id>.json      the collection
    <id>.jpg       optional cover
  featured.json    maintainers only: the few shown first on each page
```

- **`type`** is one of the types below. It also decides where the files are saved in
  people's libraries.
- **`id`** is lowercase words joined by hyphens, like `met-paintings`. It matches the
  file name and never changes after merging.
- **Cover** (optional): JPEG, 1200×800, under 300 KB, openly licensed, usually taken
  from the collection itself. Without one, the app makes a cover from the entries.

## Types

| Type | Holds | Saved to |
|---|---|---|
| `podcasts` | Show feeds; people pick episodes themselves. One list only: add shows to `podcasts/shows-worth-keeping.json`. | `Audio/Podcasts/<show>` |
| `websites` | Pages, live and/or from the Wayback Machine | `Reference/Websites/<collection>` |
| `books` | EPUB, PDF | `Documents/Books/<collection>` |
| `documents` | PDF, EPUB, CBZ: magazines, manuals, papers | `Documents/<collection>` |
| `images` | JPEG, PNG, TIFF, WebP | `Images/<collection>` |
| `music` | MP3, FLAC, OGG, M4A | `Audio/Music/<collection>` |
| `audiobooks` | MP3, M4B | `Audio/Audiobooks/<collection>` |
| `video` | MP4, WebM, MKV | `Video/<collection>` |

Each folder is found by its default name and made if it's missing. A collection's own
folder then keeps receiving its files wherever it's moved.

Wikipedia and maps aren't collection types. The app lists Kiwix's catalog directly,
and people choose their own map areas.

## The file

Every collection has these fields:

```json
{
  "id": "met-paintings",
  "type": "images",
  "title": "Paintings from the Met",
  "summary": "Public-domain paintings from The Metropolitan Museum of Art, with descriptions.",
  "topics": ["art"],
  "language": "en",
  "curator": "Your name or handle",
  "updated": "2026-10-15",
  "entries": []
}
```

| Field | Rule |
|---|---|
| `title` | Up to 50 characters, in sentence case. |
| `summary` | One sentence, up to 140 characters. Say what it is, not how good it is. |
| `topics` | One or two of: `history`, `science`, `art`, `literature`, `technology`, `music`, `nature`, `culture`, `learning`. |
| `language` | The main language, as a two-letter code. Use `zxx` when there's no language, like paintings or instrumental music. |
| `curator` | Who chose it. Shown in the app. |
| `updated` | The date of your change, as `YYYY-MM-DD`. |
| `parallel` | Optional. How many files download at once, 1 to 4. It defaults to 2, or 1 for video, and servers with their own limits get fewer whatever it says. |
| `entries` | Up to the limit for the type: 50 podcasts, 50 websites, or 300 files (25 GB in all) for the others. |

### `podcasts` entries

```json
{
  "id": "in-our-time",
  "title": "In Our Time",
  "feed": "https://podcasts.files.bbci.co.uk/b006qykl.rss",
  "note": "Melvyn Bragg and three experts on one idea, from Plato to plate tectonics."
}
```

`feed` is the show's RSS address. `note` is optional, up to 120 characters, and says
why this show.

### `websites` entries

```json
{
  "id": "first-website",
  "title": "The first website",
  "url": "http://info.cern.ch/hypertext/WWW/TheProject.html",
  "dates": ["1997-01-01", "live"],
  "note": "Tim Berners-Lee's page about the World Wide Web project."
}
```

- `dates` lists up to 5 dates, as `YYYY-MM-DD` or `live`. Each date becomes its own
  saved page.
- A date uses the Wayback Machine's closest copy. `live` saves the page as it is on
  the day it's saved.

### File entries (`books`, `documents`, `images`, `music`, `audiobooks`, `video`)

```json
{
  "id": "pride-and-prejudice",
  "title": "Pride and Prejudice",
  "creator": "Jane Austen",
  "date": "1813",
  "url": "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download",
  "source": "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
  "rights": "Public domain",
  "description": "Optional. A sentence or two, shown in the file's details.",
  "bytes": 0,
  "sha256": ""
}
```

| Field | Rule |
|---|---|
| `url` | A direct link to the file itself, in a format the type allows. The check reads the file's first bytes, so a web page or the wrong format fails. |
| `source` | The page people can visit to see where the file came from. |
| `rights` | What the source says about rights, briefly: `Public domain`, `CC BY 4.0`, `© The Estate; free to download`. Shown in the file's details. |
| `creator`, `date`, `description` | Optional. Saved into each file's details. |
| `bytes`, `sha256` | Leave as `0` and `""`. The fill command writes them. |

### Entry IDs

Each entry has an `id` that is unique within its collection. Never change or reuse
one: the app uses it to tell which entries are new and which are already saved. To
replace an entry, give the new one a new `id`.

## Steps

1. Create `collections/<type>/<id>.json` from the examples above.
2. Run `npm run collections -- --fill collections/<type>/<id>.json`. It downloads each
   new file once, three seconds apart, confirms it's the right kind of file, and writes
   in its size and checksum. If a server asks it to slow down, it waits.
3. Run `npm run collections -- --online collections/<type>/<id>.json`. It asks every
   address once, without downloading whole files: each feed parses, each Wayback date
   has a copy nearby, each file is still the same size.
4. Run `npm run collections`. It checks everything and rebuilds
   `collections/collections.json`, the one file the app reads. Commit both.
5. Open a pull request titled `Collection: <title>`. In the description, say who it's
   for and why these entries. Include the total size.

## Review

A maintainer checks:
- the rights for each source
- that the entries live up to the summary
- whether it overlaps something already there

Maintainers also choose the featured collections (podcasts can't be featured). Changes to an
existing collection are always welcome: fixing a link, adding a strong entry, or
removing a weak one.

## Reporting a problem

If a collection includes something it shouldn't, open an issue titled
`Collection problem: <title>`, or email the maintainers. A collection removed from
the main branch leaves every app the next time it checks.
