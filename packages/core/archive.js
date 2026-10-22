import { createHash, randomUUID } from "node:crypto";
import { transferError } from "./transfer-errors.js";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, writeFile, stat, rm, rmdir, realpath } from "node:fs/promises";
import { sourceDate, fileDate } from "./dates.js";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { classify, accessNote, shelfOf, hasKind } from "../types/index.js";

export function safeFilename(input) {
  let name = String(input)
    .normalize("NFC")
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name || /^\.+$/.test(name)) name = "untitled";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  if (name.toLowerCase() === "item.json") name = "content-item.json";
  const ext = path.extname(name).slice(0, 20);
  while (Buffer.byteLength(name) > 160)
    name =
      [...name.slice(0, -ext.length || undefined)].slice(0, -1).join("") + ext;
  return name;
}

/** Writes JSON through a temporary file, so a failed write never leaves half a file. */
export async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
/**
 * Whether the folder `target` would be written in is inside `root`, symlinks included.
 * `target` need not exist yet: its nearest existing folder is what's checked.
 */
export async function insideLibrary(root, target) {
  const [base, dir] = await Promise.all([resolved(root), resolved(path.dirname(target))]);
  return dir === base || dir.startsWith(base + path.sep);
}
/** Where `file` really is: its nearest existing folder with links followed, then the rest. */
async function resolved(file) {
  let at = path.resolve(file);
  const rest = [];
  for (;;)
    try {
      return path.join(await realpath(at), ...rest);
    } catch (error) {
      if (error.code !== "ENOENT" || at === path.dirname(at)) throw error;
      rest.unshift(path.basename(at));
      at = path.dirname(at);
    }
}
export const OUTSIDE = "This folder now leads outside the library, so nothing was saved there.";
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function receiveFile(
  stream,
  destination,
  maxBytes = 4 * 1024 ** 3,
) {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxBytes
          ? new Error("File exceeds the 4 GB import limit.")
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      stream,
      limiter,
      createWriteStream(destination, { flags: "wx" }),
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

const importQueues = new WeakMap();
export function importFile(options) {
  const previous = importQueues.get(options.catalog) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => commitImport(options));
  importQueues.set(options.catalog, next);
  return next;
}

/** Where a file will be filed: a named shelf wins; otherwise it is filed by what it is. */
export function fileTarget(filename, { type, kind, fallback } = {}) {
  const found = classify(filename),
    shelf =
      shelfOf(type) ||
      (found.type === "other" && shelfOf(fallback)) ||
      shelfOf(found.type);
  return {
    type: shelf.id,
    kind: hasKind(shelf.id, kind) ? kind : shelf.id === found.type ? found.kind : "",
  };
}
async function commitImport({
  catalog,
  archiveRoot,
  temporaryPath,
  filename,
  title,
  description = "",
  source,
  rights,
  id = randomUUID(),
  demo = false,
  type,
  collection,
  expectedSha256,
  expectedBytes,
  software,
  kind,
  fallback,
  created,
  creator,
  directory,
}) {
  filename = safeFilename(filename);
  const target = fileTarget(filename, { type, kind, fallback }),
    shelf = shelfOf(target.type);
  kind = target.kind;
  const checksum = await hashFile(temporaryPath);
  const bytes = (await stat(temporaryPath)).size;
  // Not the file that was described: the source has changed it, or sent something else.
  if (expectedBytes && bytes !== expectedBytes)
    throw transferError("The file's size differs from what its source described. Nothing was saved.", "changed");
  if (expectedSha256 && checksum !== expectedSha256)
    throw transferError("The file differs from the one its source described (checksum). Nothing was saved.", "changed");
  // The date of the work: given, known from where it came from, or written in the file.
  const dated = created || sourceDate(source) || (await fileDate(temporaryPath, filename));
  const collectionFolder = collection
    ? `${safeFilename(collection.title).slice(0, 70)}--${String(collection.id)
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 32)}/`
    : "";
  const readableName = safeFilename(title?.trim() || filename).slice(0, 75);
  const safeId = String(id)
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 40);
  // A file goes into the folder it was given; libraries without folders use its shelf.
  const parent = typeof directory === "string" ? directory : `${shelf.folder}/${collectionFolder}`.replace(/\/$/, "");
  let relativeDirectory = `${parent ? parent + "/" : ""}${readableName}--${safeId.slice(0, 8)}`;
  try {
    await stat(path.join(archiveRoot, relativeDirectory));
    relativeDirectory = `${parent ? parent + "/" : ""}${readableName}--${safeId}`;
  } catch {}
  const itemDirectory = path.join(archiveRoot, relativeDirectory);
  // A folder since replaced by a link to somewhere else is never followed.
  if (!(await insideLibrary(archiveRoot, path.join(itemDirectory, filename)))) throw new Error(OUTSIDE);
  const made = await mkdir(itemDirectory, { recursive: true });
  const item = {
    schemaVersion: 1,
    id,
    ...(software || shelf.id === "software"
      ? {
          software: software || {
            platform: "unknown",
            arch: "unknown",
            offlineTested: false,
          },
        }
      : {}),
    ...(kind ? { kind } : {}),
    title: title?.trim() || filename,
    description,
    ...(dated ? { created: dated } : {}),
    ...(creator ? { creator: String(creator).slice(0, 200) } : {}),
    type: shelf.id,
    filename,
    path: `${relativeDirectory}/${filename}`,
    bytes,
    sha256: checksum,
    acquiredAt: new Date().toISOString(),
    source: source || { adapter: "import", provider: "Local import" },
    rights: rights || "Not specified; check the original source.",
    integrity: expectedSha256 ? "publisher-verified" : "hashed",
    offlineTested: false,
    accessNote: accessNote(filename, shelf.id),
    demo,
    ...(collection ? { collection } : {}),
  };
  // Files and the manifest are committed before the rebuildable catalog. Without its
  // manifest (a full disk) the file goes back, and the import fails having saved
  // nothing. If even that fails, the file stays, and Check archive finds it.
  const saved = path.join(itemDirectory, filename);
  await rename(temporaryPath, saved);
  try {
    await writeJson(path.join(itemDirectory, "item.json"), item);
  } catch (error) {
    await rename(saved, temporaryPath);
    // Folders made for it would otherwise be read as new, empty folders.
    if (made)
      for (let dir = itemDirectory; dir.length >= made.length; dir = path.dirname(dir))
        await rmdir(dir).catch(() => {});
    throw error;
  }
  catalog.put(item);
  return { item, duplicate: false };
}
