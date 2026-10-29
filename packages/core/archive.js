import { createHash, randomUUID } from "node:crypto";
import { transferError } from "./transfer-errors.js";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import { mkdir, rename, writeFile, stat, statfs, rm, rmdir, realpath, copyFile, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sourceDate, fileDate } from "./dates.js";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { classify, accessNote, shelfOf, hasKind } from "../types/index.js";
const execFileAsync = promisify(execFile);

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
// Large reads: a 64 KB default makes a big file's checksum take half again as long.
const CHUNK = 4 * 1024 ** 2;
/** A file's SHA-256. `progress` is told how many bytes have been read so far. */
export async function hashFile(file, progress) {
  return (await readChecksums(file, progress)).sha256;
}

/**
 * Where a ZIM keeps the MD5 of everything before it, and that MD5. Kiwix writes it
 * when it builds the file, so a match means the file is exactly what was published.
 */
async function zimChecksum(file) {
  if (!/\.zim$/i.test(file)) return null;
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(80),
      { size } = await handle.stat();
    if ((await handle.read(head, 0, 80, 0)).bytesRead < 80 || head.readUInt32LE(0) !== 72173914) return null;
    const at = Number(head.readBigUInt64LE(72));
    if (at < 80 || at + 16 > size) return null;
    const stored = Buffer.alloc(16);
    await handle.read(stored, 0, 16, at);
    return { at, md5: stored.toString("hex") };
  } finally {
    await handle.close();
  }
}
/** Takes a file's bytes in order and gives its checksums once they have all been seen. */
async function checksummer(file) {
  const sha = createHash("sha256"),
    zim = await zimChecksum(file).catch(() => null),
    md5 = zim && createHash("md5");
  let done = 0;
  return {
    update(chunk) {
      sha.update(chunk);
      if (md5 && done < zim.at) md5.update(done + chunk.length <= zim.at ? chunk : chunk.subarray(0, zim.at - done));
      return (done += chunk.length);
    },
    // `embedded`: true or false for a file that carries its own checksum, else null.
    finish: () => ({ sha256: sha.digest("hex"), embedded: md5 ? md5.digest("hex") === zim.md5 : null }),
  };
}
/** Stopped reading on purpose: paused, or the library closed. */
export class Stopped extends Error {}
/**
 * Reads a file once for its SHA-256, and, for a file that carries its own checksum
 * (a ZIM), whether it still matches. `stopped()` is asked between reads.
 */
export async function readChecksums(file, progress, stopped = () => false) {
  const sums = await checksummer(file);
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK })) {
    if (stopped()) throw new Stopped("Stopped.");
    const done = sums.update(chunk);
    progress?.(done);
  }
  return sums.finish();
}
/**
 * What a check compares instead of reading the file: its size and modified date, as
 * rsync and git do, and its file ID, which a move on the same drive keeps.
 */
export const stampOf = (info) => ({ size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
// Dates are compared to the millisecond: tools that copy or restore files often keep no more.
export const sameStamp = (stamp, info) => !!stamp && stamp.size === info.size && Math.abs(stamp.mtimeMs - info.mtimeMs) < 1;

const sizeText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const clonable = new Map();
/**
 * Whether the drive holding `dir` can clone files, sharing storage between copies:
 * APFS on macOS, Btrfs or XFS on Linux. Mac OS Extended (HFS+) and exFAT can't.
 */
export async function canClone(dir) {
  const { dev } = await stat(dir);
  if (!clonable.has(dev)) clonable.set(dev, cloneSupport(dir));
  return clonable.get(dev);
}
async function cloneSupport(dir) {
  try {
    if (process.platform === "darwin") {
      // The drive whose mount point holds the folder, the longest one that does.
      const real = await realpath(dir),
        { stdout } = await execFileAsync("/sbin/mount");
      let found = null;
      for (const line of stdout.split("\n")) {
        const [, at, type] = / on (.+) \(([^,)]+)/.exec(line) || [];
        if (at && (real === at || real.startsWith(at === "/" ? "/" : `${at}/`)) && (!found || at.length > found.at.length)) found = { at, type };
      }
      return found?.type === "apfs";
    }
    if (process.platform === "linux") return [0x9123683e, 0x58465342].includes((await statfs(dir)).type);
  } catch {}
  return false;
}
/** A copy that shares the original's storage, or false where one can't be made. */
function cloneFile(source, destination, bytes) {
  if (process.platform !== "darwin")
    return copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE).then(
      () => true,
      () => rm(destination, { force: true }).then(() => false),
    );
  // Node's own clone flag copies in full on macOS; cp -c makes a real APFS clone.
  return new Promise((resolve) => {
    const child = execFile("/bin/cp", ["-c", "--", source, destination], (error) => {
      clearInterval(watch);
      if (error) rm(destination, { force: true }).then(() => resolve(false), () => resolve(false));
      else resolve(true);
    });
    // A clone appears whole at once. One that grows is cp copying instead, slowly and
    // with no way to show progress, so it is stopped.
    const watch = setInterval(() => {
      stat(destination).then(({ size }) => size < bytes && child.kill(), () => {});
    }, 100);
  });
}
/**
 * Copies a file in. A copy from another drive is read once, checksummed as it is
 * written, and returns its checksums. On a drive that clones, the copy takes no time
 * or space and its checksums are left for later: `{ sha256: null }`.
 */
export async function copyIn(source, destination, progress) {
  const [from, to, into] = await Promise.all([stat(source), stat(path.dirname(destination)), statfs(path.dirname(destination))]);
  if (from.dev === to.dev && (await canClone(path.dirname(destination)))) {
    progress?.(0, "copying");
    if (await cloneFile(source, destination, from.size)) return { sha256: null, embedded: null };
  }
  const free = into.bavail * into.bsize;
  if (from.size > free - 512 * 1024 ** 2)
    throw new Error(`Not enough disk space. This needs ${sizeText(from.size)}; ${sizeText(Math.max(0, free))} is free.`);
  const sums = await checksummer(source);
  await pipeline(
    createReadStream(source, { highWaterMark: CHUNK }),
    new Transform({
      transform(chunk, encoding, callback) {
        const done = sums.update(chunk);
        progress?.(done, "copying");
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx" }),
  );
  return sums.finish();
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
  // Already worked out while the file was copied in, with whether it matched the
  // checksum the file carries itself (a ZIM).
  sha256,
  embedded = null,
  // Moved or cloned in: usable at once, its checksum read in the background after.
  pending = false,
}) {
  filename = safeFilename(filename);
  const target = fileTarget(filename, { type, kind, fallback }),
    shelf = shelfOf(target.type);
  kind = target.kind;
  const checksum = sha256 || (pending ? null : await hashFile(temporaryPath));
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
    integrity: expectedSha256 || embedded ? "publisher-verified" : checksum ? "hashed" : "pending",
    ...(checksum ? { verifiedAt: new Date().toISOString() } : {}),
    ...(embedded === false ? { fileState: "damaged" } : {}),
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
  item.stamp = stampOf(await stat(saved));
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
