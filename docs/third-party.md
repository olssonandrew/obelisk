# Third-party software, data and services

## Licensing of release builds

Obelisk's own code is MIT ([LICENSE](../LICENSE)). The bundled Wikipedia reader,
OpenZIM javascript-libzim v0.95, is **GPL-3.0-or-later**, so any build that includes it
must be distributed under GPL-3.0-or-later. Each component keeps its own license. This
allows selling the open-source app; it doesn't allow a closed-source build.

Before publishing binaries, provide the complete corresponding source for the exact
WASM build and its dependencies, build scripts included. A link to the upstream
project isn't enough on its own. The GPL text, engine URLs, checksums and upstream
source are in `desktop/zim/vendor/` (`LICENSE-GPL-3.0.txt`, `SOURCE.json`). Never
replace the runtime without updating its checksums and source record.

## Bundled

| Component | License | Where |
|---|---|---|
| OpenZIM javascript-libzim (WASM) | GPL-3.0-or-later | `desktop/zim/vendor/` |
| MapLibre GL JS | BSD-3-Clause | `desktop/map/vendor/` (built by `npm run build`) |
| PMTiles | BSD-3-Clause | `desktop/map/vendor/`, [PMTiles-LICENSE.txt](PMTiles-LICENSE.txt) |
| @protomaps/basemaps | BSD-3-Clause | `desktop/map/vendor/` |
| pdf.js | Apache-2.0 | `desktop/renderer/reader/vendor/` (built by `npm run build`) |
| JSZip | MIT (chosen of its dual license) | `desktop/renderer/reader/vendor/` |
| marked | MIT | `desktop/renderer/reader/vendor/` |
| DOMPurify | Apache-2.0 (chosen of its dual license) | `desktop/renderer/reader/vendor/` |
| World outline | See `desktop/map/world-LICENSE.txt` | `desktop/map/world.json` |

## Installed on first use, not bundled

Video downloads install these into the app's own data folder, checked against the
publishers' checksums, with their license notices saved beside them. yt-dlp's
standalone releases contain GPLv3+ parts; FFmpeg's license depends on the build.

- yt-dlp: <https://github.com/yt-dlp/yt-dlp#licensing>
- FFmpeg for macOS and Linux (Martin Riedl): <https://ffmpeg.martin-riedl.de/>
- FFmpeg for Windows (BtbN): <https://github.com/BtbN/FFmpeg-Builds>
- FFmpeg licensing: <https://ffmpeg.org/legal.html>

## Services Obelisk talks to

| Service | Used for | Terms |
|---|---|---|
| OpenStreetMap tiles | The map chooser's preview only | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/): visible tiles only, attributed, no bulk download |
| Protomaps builds | Saved maps | Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL; [data attribution](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md) |
| Kiwix catalog | Wikipedia and other ZIM editions | Content keeps its own license (Wikipedia: CC BY-SA) |
| Apple podcast directory, publisher feeds | Podcast search and episodes | Publisher rights apply |
| Wayback Machine | Earlier copies of web pages | Polite use: one shared connection, spaced lookups |
| Collection sources | Files listed in `collections/` | Each entry records its source's rights statement |

## Demo and screenshots

The README screenshots are captured with `npm run screenshots` from the demo library
built by `npm run demo:library`. Its contents:
- **Paintings:** Art Institute of Chicago, CC0.
- **NASA photographs and documents:** public domain.
- **Books:** Project Gutenberg, public domain.
- **Recordings:** Wikimedia Commons; each file's license is in its details.
- **Film trailers:** Blender Foundation, CC BY 3.0.
- **Maps:** OpenStreetMap, as above.
- **Wikipedia:** Kiwix, CC BY-SA.
