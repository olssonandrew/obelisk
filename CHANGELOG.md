# Changelog

Each release's notes are its section here. `npm run release` refuses a version
without one, and the Release workflow publishes the section as the release notes.

## 0.1.2

- The Mac app is signed and notarized by Apple, so it opens like any other app.
- Files moved or cloned into the library are read only when you run Verify contents.
  A ZIM's own checksum is recorded when it's added.
- Fixed: a file edited while its folder moved, or while it was being deleted, could
  drop out of the library's list or come back after deletion.

## 0.1.1

The first public beta.

- A library of plain files and folders on your own drive, with tags, ratings, notes,
  search and an integrity check. The catalog rebuilds from the files.
- Downloads: Wikipedia and other Kiwix editions, maps of any area, web pages live or
  from the Wayback Machine, podcasts, video from a link, software and AI models, and
  direct links. Transfers pause, resume and retry, and stay polite to each server.
- Readers for PDF, EPUB, Markdown, text, Wikipedia, saved web pages, maps, audio and
  video, all offline.
- Collections: books, paintings, drawings, photography, early websites, podcasts,
  music and films to save in one step.
- Tested most on Apple Silicon Macs. Windows and Linux builds are experimental.

## 0.1.0

Tagged but never published: its release builds failed their launch checks. 0.1.1 is
the same release.
