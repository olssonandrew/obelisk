/**
 * The collection format: what a collection file may hold, and the check that the
 * app, the command line and CI all share. See collections/README.md.
 */

/** Families of file a type may hold, read from a file's first bytes. */
export const TYPES = {
  podcasts: { label: "Podcasts", noun: ["show", "shows"], importer: "podcasts", limit: 50 },
  websites: {
    label: "Websites",
    noun: ["page", "pages"],
    importer: "web",
    folder: ["Reference", "Websites"],
    limit: 50,
    parallel: 2,
  },
  books: {
    label: "Books",
    noun: ["book", "books"],
    importer: "documents",
    folder: ["Documents", "Books"],
    formats: ["epub", "pdf"],
    file: { type: "document", kind: "book" },
    limit: 300,
    parallel: 2,
  },
  documents: {
    label: "Documents",
    noun: ["document", "documents"],
    importer: "documents",
    folder: ["Documents"],
    formats: ["pdf", "epub", "zip"],
    file: { type: "document" },
    limit: 300,
    parallel: 2,
  },
  images: {
    label: "Images",
    noun: ["image", "images"],
    importer: "images",
    folder: ["Images"],
    formats: ["jpeg", "png", "tiff", "webp", "gif"],
    file: { type: "image", kind: "art" },
    limit: 300,
    parallel: 2,
  },
  music: {
    label: "Music",
    noun: ["recording", "recordings"],
    importer: "audio",
    folder: ["Audio", "Music"],
    formats: ["mp3", "flac", "ogg", "mp4"],
    file: { type: "audio", kind: "music" },
    limit: 300,
    parallel: 2,
  },
  audiobooks: {
    label: "Audiobooks",
    noun: ["file", "files"],
    importer: "audio",
    folder: ["Audio", "Audiobooks"],
    formats: ["mp3", "mp4", "ogg"],
    file: { type: "audio", kind: "audiobook" },
    limit: 300,
    parallel: 2,
  },
  video: {
    label: "Video",
    noun: ["video", "videos"],
    importer: "video",
    folder: ["Video"],
    formats: ["mp4", "matroska", "ogg"],
    file: { type: "video", kind: "film" },
    limit: 300,
    parallel: 1,
  },
};
export const TOPICS = ["history", "science", "art", "literature", "technology", "music", "nature", "culture", "learning"];
export const MAX_PARALLEL = 4;
export const MAX_BYTES = 25 * 1024 ** 3;
export const FORMAT = 1;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  DAY = /^\d{4}-\d{2}-\d{2}$/,
  SHA256 = /^[0-9a-f]{64}$/;
export const isFileType = (type) => !!TYPES[type]?.formats;

function webAddress(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
const realDay = (value) => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * Checks one collection. Returns a list of problems, each naming where it is; an empty
 * list means it's fine. `draft` allows file entries whose size and checksum haven't been
 * filled in yet. `strict` refuses fields the format doesn't know, which keeps the files
 * in the repository tidy; the app is lenient, so newer files still load in older apps.
 */
export function check(collection, { draft = false, strict = false } = {}) {
  const problems = [],
    at = (where, text) => problems.push(`${where}: ${text}`);
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return ["The file must hold one JSON object."];
  const c = collection,
    type = TYPES[c.type];
  const text = (where, value, max, required = true) => {
    if (value === undefined || value === "") {
      if (required) at(where, "is required");
      return;
    }
    if (typeof value !== "string" || !value.trim()) at(where, "must be text");
    else if (value.length > max) at(where, `must be at most ${max} characters`);
  };
  const known = (where, value, fields) => {
    if (!strict) return;
    for (const key of Object.keys(value)) if (!fields.includes(key)) at(where, `has an unknown field "${key}"`);
  };
  if (typeof c.id !== "string" || !ID.test(c.id) || c.id.length > 60) at("id", "must be lowercase words joined by hyphens");
  if (!type) at("type", `must be one of ${Object.keys(TYPES).join(", ")}`);
  text("title", c.title, 50);
  text("summary", c.summary, 140);
  text("curator", c.curator, 80);
  if (!Array.isArray(c.topics) || !c.topics.length || c.topics.length > 2 || c.topics.some((t) => !TOPICS.includes(t)))
    at("topics", `must be one or two of ${TOPICS.join(", ")}`);
  if (typeof c.language !== "string" || !/^[a-z]{2,3}$/.test(c.language)) at("language", "must be a language code, like en, or zxx for none");
  if (!realDay(c.updated)) at("updated", "must be a date, as YYYY-MM-DD");
  if (c.parallel !== undefined && (!Number.isInteger(c.parallel) || c.parallel < 1 || c.parallel > MAX_PARALLEL))
    at("parallel", `must be a whole number from 1 to ${MAX_PARALLEL}`);
  known("collection", c, ["id", "type", "title", "summary", "topics", "language", "curator", "updated", "parallel", "entries"]);
  if (!Array.isArray(c.entries) || !c.entries.length) {
    at("entries", "must list at least one entry");
    return problems;
  }
  if (type && c.entries.length > type.limit) at("entries", `may hold at most ${type.limit} for ${c.type}`);
  const ids = new Set();
  let bytes = 0;
  c.entries.forEach((e, n) => {
    const where = `entries[${n}]${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) return at(where, "must be an object");
    if (typeof e.id !== "string" || !ID.test(e.id) || e.id.length > 80) at(`${where} id`, "must be lowercase words joined by hyphens");
    else if (ids.has(e.id)) at(`${where} id`, "is used twice");
    else ids.add(e.id);
    text(`${where} title`, e.title, 200);
    if (!type) return;
    if (c.type === "podcasts") {
      if (!webAddress(e.feed)) at(`${where} feed`, "must be a web address");
      text(`${where} note`, e.note, 140, false);
      known(where, e, ["id", "title", "feed", "note"]);
    } else if (c.type === "websites") {
      if (!webAddress(e.url)) at(`${where} url`, "must be a web address");
      if (!Array.isArray(e.dates) || !e.dates.length || e.dates.length > 5) at(`${where} dates`, "must list from 1 to 5 dates");
      else {
        if (new Set(e.dates).size !== e.dates.length) at(`${where} dates`, "lists a date twice");
        for (const d of e.dates)
          if (d !== "live" && !(realDay(d) && d >= "1996-01-01")) at(`${where} dates`, `"${d}" must be live, or a date from 1996 on as YYYY-MM-DD`);
      }
      text(`${where} note`, e.note, 140, false);
      known(where, e, ["id", "title", "url", "dates", "note"]);
    } else {
      if (!webAddress(e.url)) at(`${where} url`, "must be a web address");
      if (!webAddress(e.source)) at(`${where} source`, "must be the web address of the page it came from");
      text(`${where} rights`, e.rights, 200);
      text(`${where} creator`, e.creator, 200, false);
      text(`${where} date`, e.date, 40, false);
      text(`${where} description`, e.description, 2000, false);
      const filled = Number.isInteger(e.bytes) && e.bytes > 0;
      if (!filled && !(draft && (e.bytes === undefined || e.bytes === 0))) at(`${where} bytes`, "is missing; run the fill command");
      if (filled) bytes += e.bytes;
      if (e.sha256 !== undefined && e.sha256 !== "" && !SHA256.test(e.sha256)) at(`${where} sha256`, "must be 64 lowercase hex characters");
      if (!draft && !SHA256.test(e.sha256 || "")) at(`${where} sha256`, "is missing; run the fill command");
      known(where, e, ["id", "title", "creator", "date", "url", "source", "rights", "description", "bytes", "sha256"]);
    }
  });
  if (bytes > MAX_BYTES) at("entries", "add up to more than 25 GB; split the collection");
  return problems;
}

/** How many downloads a collection runs at once. */
export const parallelOf = (c) => Math.min(MAX_PARALLEL, c.parallel || TYPES[c.type]?.parallel || 2);
/** Total size of a collection's files, or of some of its entries. */
export const sizeOf = (c, entries = c.entries) => entries.reduce((n, e) => n + (e.bytes || 0), 0);
/** What a saved entry is known by: websites save one copy per date. */
export const entryKeys = (c, e) => (c.type === "websites" ? e.dates.map((d) => `${e.id}@${d}`) : [e.id]);

/**
 * Reads a published bundle. Collections that don't pass the check are left out one
 * by one, so a single bad file never hides the rest, and types this version doesn't
 * know yet are skipped quietly.
 */
export function readBundle(bundle) {
  if (!bundle || bundle.format !== FORMAT || !Array.isArray(bundle.collections)) throw new Error("This isn't a collections file this version of Obelisk can read.");
  const collections = [],
    skipped = [];
  for (const c of bundle.collections) {
    if (!TYPES[c?.type]) continue;
    const problems = check(c);
    if (problems.length) skipped.push({ id: c?.id, problems });
    else collections.push(c);
  }
  const ids = new Set(collections.map((c) => c.id));
  return {
    built: typeof bundle.built === "string" ? bundle.built : null,
    featured: (Array.isArray(bundle.featured) ? bundle.featured : []).filter((id) => ids.has(id)),
    collections,
    skipped,
  };
}

/**
 * The family of file from its first bytes: enough to tell a book from a web page that
 * stands in for one when a site blocks a download.
 */
export function sniff(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    ascii = (from, to) => b.subarray(from, to).toString("latin1");
  if (b.length < 4) return null;
  if (ascii(0, 4) === "%PDF") return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)
    return ascii(30, 58) === "mimetypeapplication/epub+zip" ? "epub" : "zip";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "tiff";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(4, 8) === "ftyp") return "mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  const start = ascii(0, 512).replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart().slice(0, 64).toLowerCase();
  if (start.startsWith("<!doctype html") || start.startsWith("<html") || start.startsWith("<head") || start.startsWith("<?xml") || start.startsWith("<!--"))
    return "html";
  return null;
}
