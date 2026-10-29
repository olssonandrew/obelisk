# Third-party software, data and services

## Licensing of release builds

Obelisk's own code is MIT ([LICENSE](../LICENSE)). The bundled Wikipedia reader,
OpenZIM javascript-libzim v0.95, is **GPL-3.0-or-later**, so any build that includes it
must be distributed under GPL-3.0-or-later. Each component keeps its own license. This
allows selling the open-source app; it doesn't allow a closed-source build.

Each release publishes its complete corresponding source beside the builds as
`Obelisk-<version>-source.tar`, made by `scripts/gpl-source.js`: Obelisk at the
released commit, the javascript-libzim source with the Makefile that builds the WASM,
and the source of every library that Makefile downloads (libzim, Xapian, ICU, zstd,
zlib, xz). A link to the upstream project isn't enough on its own, so the archives are
copied, not linked. The GPL text, engine checksums and the pinned source archives are
in `desktop/zim/vendor/` (`LICENSE-GPL-3.0.txt`, `SOURCE.json`). Never replace the
runtime without updating its checksums and source record, including
`correspondingSource`.

## Bundled

| Component | License | Where |
|---|---|---|
| OpenZIM javascript-libzim (WASM) | GPL-3.0-or-later | `desktop/zim/vendor/` |
| MapLibre GL JS | BSD-3-Clause | `desktop/map/vendor/` (built by `npm run build`) |
| PMTiles | BSD-3-Clause | `desktop/map/vendor/`, [license text](#pmtiles-license) |
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
| OpenFreeMap | The map chooser's street preview only | [OpenFreeMap](https://openfreemap.org/): free, no key; attribution "OpenFreeMap © OpenMapTiles, data from OpenStreetMap". OpenStreetMap's own tile servers refuse app pages that have no web address. |
| Protomaps builds | Saved maps | Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL; [data attribution](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md) |
| Kiwix catalog | Wikipedia and other ZIM editions | Content keeps its own license (Wikipedia: CC BY-SA) |
| Apple podcast directory, publisher feeds | Podcast search and episodes | Publisher rights apply |
| Wayback Machine | Earlier copies of web pages | Polite use: one shared connection, spaced lookups |
| Collection sources | Files listed in `collections/` | Each entry records its source's rights statement |

## Visual art collections

- **Paintings, drawings, and original prints:** Art Institute of Chicago, Cleveland
  Museum of Art, and Metropolitan Museum of Art, public domain/CC0 images; National
  Gallery of Art, public-domain Open Access images and CC0 metadata. Cleveland
  metadata and accompanying descriptions are also CC0. Individual Wikimedia Commons
  records identify the landmark painting reproductions as public domain (PD-Art).
- **Photography:** Cleveland Museum of Art, CC0; Library of Congress individual
  records state "No known restrictions" or "No known restrictions on publication."
  These advisories are retained rather than relabeled as a Creative Commons license.

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

## PMTiles license

```text
The below license (BSD-3) applies to the reference implementations in this repository.

The PMTiles specification itself is public domain, or CC0 where applicable.

Sample tilesets available in this repository are subject to their own license terms.

---

Copyright 2021 Protomaps LLC

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
