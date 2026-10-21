// The date a work was made, filled in when a file or its source says so. Only small
// parts of a file are read (headers, a ZIP's index), never the whole thing.
import { open } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

/** "YYYY-MM-DD" (or "YYYY-MM", "YYYY") when the parts make a plausible date. */
function day(year, month, date) {
  const y = Number(year), m = Number(month), d = Number(date);
  if (!(y >= 1800 && y <= new Date().getFullYear() + 1)) return null;
  if (!month) return String(y);
  if (!(m >= 1 && m <= 12)) return String(y);
  if (!date) return `${y}-${String(m).padStart(2, "0")}`;
  if (!(d >= 1 && d <= 31)) return `${y}-${String(m).padStart(2, "0")}`;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Reads the leading date out of common spellings: 2024-05-01, 2024:05:01, 20240501, D:20240501… */
export function readDate(value) {
  const text = String(value ?? "").trim();
  const match =
    /^(?:D:)?(\d{4})[-:/]?(\d{2})?[-:/]?(\d{2})?/.exec(text) ||
    /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? day(match[1], match[2], match[3]) : null;
}

/** Dates the place a download came from already knows. */
export function sourceDate(source = {}) {
  switch (source.adapter) {
    case "web":
      // A Wayback copy is the page as it was then; a live save is the page as it is now.
      return readDate(source.snapshot) || readDate(source.capturedAt);
    case "maps":
      return readDate(source.version); // when the OpenStreetMap data was built
    case "podcasts":
      return readDate(source.published && new Date(source.published).toISOString());
    case "wikipedia":
      return readDate(source.version);
    case "video":
      return readDate(source.uploaded);
    default:
      return null;
  }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
  return buffer.subarray(0, bytesRead);
}

/* EXIF (JPEG, HEIC, PNG, TIFF and raw camera files) */
function tiffDate(tiff) {
  if (tiff.length < 8) return null;
  const little = tiff.toString("latin1", 0, 2) === "II";
  if (!little && tiff.toString("latin1", 0, 2) !== "MM") return null;
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const tags = (at) => {
    const found = new Map();
    if (at + 2 > tiff.length) return found;
    const count = u16(at);
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      found.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), at: entry + 8 });
    }
    return found;
  };
  const text = (tag) => {
    if (!tag || tag.type !== 2) return null;
    const start = tag.count > 4 ? tag.value : tag.at;
    return start + tag.count <= tiff.length ? tiff.toString("latin1", start, start + tag.count) : null;
  };
  const first = tags(u32(4)),
    exif = first.get(0x8769) ? tags(first.get(0x8769).value) : new Map();
  // Taken, then digitised, then the file's own date.
  return readDate(text(exif.get(0x9003))) || readDate(text(exif.get(0x9004))) || readDate(text(first.get(0x0132)));
}
async function jpegDate(handle) {
  const head = await readAt(handle, 0, 256 * 1024);
  for (let at = 2; at + 4 < head.length; ) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1],
      length = head.readUInt16BE(at + 2);
    if (marker === 0xe1 && head.toString("latin1", at + 4, at + 10) === "Exif\0\0")
      return tiffDate(head.subarray(at + 10, at + 2 + length));
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}
async function pngDate(handle) {
  const head = await readAt(handle, 0, 512 * 1024);
  for (let at = 8; at + 8 < head.length; ) {
    const length = head.readUInt32BE(at),
      type = head.toString("latin1", at + 4, at + 8),
      data = head.subarray(at + 8, at + 8 + length);
    if (type === "eXIf") return tiffDate(data);
    if (type === "tEXt" && data.toString("latin1").startsWith("Creation Time\0"))
      return readDate(new Date(data.toString("latin1").slice(14)).toISOString?.() || "");
    if (type === "IDAT" || type === "IEND") return null;
    at += 12 + length;
  }
  return null;
}
/** Boxes in an ISO media file (HEIC, MP4, MOV): [type, start of contents, end]. */
async function boxes(handle, start, end) {
  const found = [];
  for (let at = start; at + 8 <= end; ) {
    const head = await readAt(handle, at, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0),
      body = at + 8;
    const type = head.toString("latin1", 4, 8);
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      body = at + 16;
    } else if (size === 0) size = end - at;
    if (size < 8) break;
    found.push([type, body, Math.min(end, at + size)]);
    at += size;
  }
  return found;
}
async function heicDate(handle, size) {
  const meta = (await boxes(handle, 0, size)).find(([type]) => type === "meta");
  if (!meta) return null;
  const inside = await boxes(handle, meta[1] + 4, meta[2]),
    box = (name) => inside.find(([type]) => type === name);
  const iinf = box("iinf"),
    iloc = box("iloc");
  if (!iinf || !iloc) return null;
  // Which item is the EXIF block…
  const info = await readAt(handle, iinf[1], iinf[2] - iinf[1]);
  let exifId = null;
  for (let at = info[0] === 0 ? 6 : 8; at + 8 < info.length; ) {
    const length = info.readUInt32BE(at),
      version = info[at + 8];
    if (info.toString("latin1", at + 4, at + 8) === "infe" && version >= 2) {
      const id = version === 2 ? info.readUInt16BE(at + 12) : info.readUInt32BE(at + 12),
        typeAt = at + 12 + (version === 2 ? 2 : 4) + 2;
      if (info.toString("latin1", typeAt, typeAt + 4) === "Exif") exifId = id;
    }
    if (length < 8) break;
    at += length;
  }
  if (exifId === null) return null;
  // …and where it is.
  const loc = await readAt(handle, iloc[1], iloc[2] - iloc[1]),
    version = loc[0],
    offsetSize = loc[4] >> 4,
    lengthSize = loc[4] & 15,
    baseSize = loc[5] >> 4,
    indexSize = version ? loc[5] & 15 : 0;
  const num = (at, bytes) => (bytes === 8 ? Number(loc.readBigUInt64BE(at)) : bytes === 4 ? loc.readUInt32BE(at) : bytes === 2 ? loc.readUInt16BE(at) : 0);
  let at = 6;
  const count = version < 2 ? loc.readUInt16BE(at) : loc.readUInt32BE(at);
  at += version < 2 ? 2 : 4;
  for (let i = 0; i < count && at < loc.length; i++) {
    const id = version < 2 ? loc.readUInt16BE(at) : loc.readUInt32BE(at);
    at += version < 2 ? 2 : 4;
    if (version) at += 2;
    at += 2;
    const base = num(at, baseSize);
    at += baseSize;
    const extents = loc.readUInt16BE(at);
    at += 2;
    for (let e = 0; e < extents; e++) {
      at += indexSize;
      const offset = num(at, offsetSize);
      at += offsetSize;
      const length = num(at, lengthSize);
      at += lengthSize;
      if (id === exifId && e === 0) {
        const block = await readAt(handle, base + offset, Math.min(length || 65536, 1024 * 1024));
        return tiffDate(block.subarray(4 + block.readUInt32BE(0)));
      }
    }
  }
  return null;
}
/* Video and AAC audio: when the movie was made, in seconds since 1904. */
async function movieDate(handle, size) {
  const moov = (await boxes(handle, 0, size)).find(([type]) => type === "moov");
  if (!moov) return null;
  const mvhd = (await boxes(handle, moov[1], moov[2])).find(([type]) => type === "mvhd");
  if (!mvhd) return null;
  const head = await readAt(handle, mvhd[1], 12),
    seconds = head[0] === 1 ? Number(head.readBigUInt64BE(4)) : head.readUInt32BE(4);
  if (!seconds) return null;
  return readDate(new Date((seconds - 2082844800) * 1000).toISOString());
}
/* MP3: the year or recording date in its ID3 tag. */
async function id3Date(handle) {
  const head = await readAt(handle, 0, 10);
  if (head.toString("latin1", 0, 3) !== "ID3") return null;
  const major = head[3],
    size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9],
    tag = await readAt(handle, 10, Math.min(size, 512 * 1024));
  const idLength = major === 2 ? 3 : 4,
    wanted = major === 2 ? ["TYE"] : ["TDRC", "TDOR", "TYER"];
  for (let at = 0; at + idLength * 2 < tag.length; ) {
    const id = tag.toString("latin1", at, at + idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const length =
      major === 2
        ? tag.readUIntBE(at + 3, 3)
        : major === 4
          ? (tag[at + 4] << 21) | (tag[at + 5] << 14) | (tag[at + 6] << 7) | tag[at + 7]
          : tag.readUInt32BE(at + 4);
    const body = at + (major === 2 ? 6 : 10);
    if (wanted.includes(id)) {
      const raw = tag.subarray(body + 1, body + length);
      const value = tag[body] === 1 || tag[body] === 2 ? raw.toString("utf16le") : raw.toString("latin1");
      return readDate(value.replace(/\0/g, ""));
    }
    at = body + length;
  }
  return null;
}
/* PDF: the creation date in its info dictionary or XMP. */
async function pdfDate(handle, size) {
  const ends = Buffer.concat([await readAt(handle, 0, 256 * 1024), await readAt(handle, Math.max(0, size - 256 * 1024), 256 * 1024)]).toString("latin1");
  const info = /\/CreationDate\s*\(\s*(D:\d{4}[^)]*)\)/.exec(ends),
    xmp = /<xmp:CreateDate>([^<]+)<|xmp:CreateDate="([^"]+)"/.exec(ends);
  return readDate(info?.[1]) || readDate(xmp?.[1] || xmp?.[2]);
}
/* ZIP-based documents: EPUB, Word, Excel, PowerPoint, OpenDocument. */
async function zipFile(handle, size, wanted) {
  const tail = await readAt(handle, Math.max(0, size - 66000), 66000),
    end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  const count = tail.readUInt16LE(end + 10),
    central = await readAt(handle, tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
  for (let at = 0, i = 0; i < count && at + 46 <= central.length; i++) {
    const method = central.readUInt16LE(at + 10),
      packed = central.readUInt32LE(at + 20),
      nameLength = central.readUInt16LE(at + 28),
      extra = central.readUInt16LE(at + 30) + central.readUInt16LE(at + 32),
      offset = central.readUInt32LE(at + 42),
      name = central.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;
    if (name !== wanted || packed > 4 * 1024 * 1024) continue;
    const local = await readAt(handle, offset, 30),
      start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
      data = await readAt(handle, start, packed);
    return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
  }
  return null;
}
async function documentDate(handle, size, ext) {
  if (ext === "epub") {
    const container = await zipFile(handle, size, "META-INF/container.xml"),
      opf = container && /full-path="([^"]+)"/.exec(container)?.[1],
      book = opf && (await zipFile(handle, size, opf));
    // The publication date, not when the file was last modified.
    const dates = [...(book || "").matchAll(/<dc:date([^>]*)>([^<]+)</g)];
    const published = dates.find(([, attrs]) => /publication/.test(attrs)) || dates.find(([, attrs]) => !/modification/.test(attrs));
    return readDate(published?.[2]);
  }
  if (["docx", "xlsx", "pptx"].includes(ext))
    return readDate(/<dcterms:created[^>]*>([^<]+)</.exec((await zipFile(handle, size, "docProps/core.xml")) || "")?.[1]);
  return readDate(/<meta:creation-date>([^<]+)</.exec((await zipFile(handle, size, "meta.xml")) || "")?.[1]);
}

const readers = {
  jpg: jpegDate, jpeg: jpegDate,
  png: pngDate,
  heic: heicDate, heif: heicDate, avif: heicDate,
  tif: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate), tiff: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate),
  dng: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate), cr2: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate),
  nef: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate), arw: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate),
  orf: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate), rw2: (h) => readAt(h, 0, 1024 * 1024).then(tiffDate),
  mp4: movieDate, m4v: movieDate, mov: movieDate, m4a: movieDate, "3gp": movieDate,
  mp3: id3Date,
  pdf: pdfDate,
  epub: (h, s) => documentDate(h, s, "epub"), docx: (h, s) => documentDate(h, s, "docx"),
  xlsx: (h, s) => documentDate(h, s, "xlsx"), pptx: (h, s) => documentDate(h, s, "pptx"),
  odt: (h, s) => documentDate(h, s, "odt"), ods: (h, s) => documentDate(h, s, "ods"), odp: (h, s) => documentDate(h, s, "odp"),
};

/** The date stored inside a file, or null. Never throws. */
export async function fileDate(file, filename = file) {
  const read = readers[path.extname(filename).slice(1).toLowerCase()];
  if (!read) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    return (await read(handle, size)) || null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
