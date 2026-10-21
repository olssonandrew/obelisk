/** Collection entries as the plans their importers already make. */
import path from "node:path";
import { TYPES, parallelOf, entryKeys } from "./format.js";
import { safeFilename } from "../core/archive.js";

const groupOf = (c) => ({ id: `collection:${c.id}`, title: c.title, parallel: parallelOf(c) });
const from = (c, entry, key, extra = {}) => ({ id: c.id, type: c.type, title: c.title, curator: c.curator, entry: entry.id, key, ...extra });

/** The file's name: its title, with the extension its address ends in. */
function filenameFor(entry, type) {
  let ext = "";
  try {
    ext = path.posix.extname(decodeURIComponent(new URL(entry.url).pathname)).toLowerCase();
  } catch {}
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) ext = { books: ".epub", documents: ".pdf", images: ".jpg", music: ".mp3", audiobooks: ".mp3", video: ".mp4" }[type] || "";
  return safeFilename(`${entry.title.slice(0, 120)}${ext}`);
}

/**
 * Plans for the chosen entries (all of them without `keys`), one per saved file:
 * websites make one per date. Podcasts make none; people choose episodes themselves.
 */
export function collectionPlans(c, keys = null) {
  const type = TYPES[c.type],
    wanted = keys && new Set(keys),
    plans = [];
  if (!type || c.type === "podcasts") return plans;
  for (const entry of c.entries)
    for (const key of entryKeys(c, entry)) {
      if (wanted && !wanted.has(key)) continue;
      if (c.type === "websites") {
        const date = key.slice(entry.id.length + 1);
        plans.push({
          driver: "web",
          url: entry.url,
          // The Wayback Machine sends any time to the copy nearest it.
          snapshot: date === "live" ? null : `${date.replace(/-/g, "")}120000`,
          filename: safeFilename(`${entry.title.slice(0, 120)}.wacz`),
          title: entry.title,
          type: "reference",
          kind: "website",
          rights: "Rights remain with the publisher. Saved as a personal reference copy.",
          group: groupOf(c),
          source: { adapter: "web", provider: date === "live" ? new URL(entry.url).hostname : "Wayback Machine", url: entry.url, collection: from(c, entry, key, { date }) },
        });
        continue;
      }
      plans.push({
        url: entry.url,
        filename: filenameFor(entry, c.type),
        title: entry.title,
        description: entry.description || "",
        creator: entry.creator,
        created: entry.date,
        rights: entry.rights,
        type: type.file.type,
        kind: type.file.kind,
        expectedBytes: entry.bytes,
        ...(entry.sha256 ? { expectedSha256: entry.sha256 } : {}),
        formats: type.formats,
        // Through the browser's own connection: some servers turn away anything else.
        browser: true,
        group: groupOf(c),
        source: { adapter: "collection", provider: new URL(entry.url).hostname, url: entry.source, downloadUrl: entry.url, collection: from(c, entry, key) },
      });
    }
  return plans;
}
