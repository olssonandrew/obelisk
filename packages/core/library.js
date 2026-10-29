import path from "node:path";
import { createTagEditor } from "./tags.js";
import {
  createManifestEditor,
  metadataPatch,
  applyMetadata,
} from "./metadata.js";
import { scanArchive, acceptCurrentFile, findUntracked } from "./reconcile.js";
import { readdir, lstat, rename, statfs } from "node:fs/promises";
import { normalizeTags } from "./tags.js";
import { writeArchiveGuide } from "./archive-guide.js";
import {
  mkdir,
  realpath,
  stat,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { sourceDate, fileDate } from "./dates.js";
import { createHash, randomUUID } from "node:crypto";
import { openCatalog, syncCatalog } from "./catalog.js";
import { importFile, fileTarget, copyIn, canClone, readChecksums, Stopped, stampOf, sameStamp, writeJson, OUTSIDE } from "./archive.js";
import { packageOf, packageSize, zipPackage } from "./bundle.js";
import { openFolders } from "./folders.js";
import { createDownloads } from "./downloads.js";
import { extractMap } from "./map-tools.js";
import { createSources } from "../sources/service.js";
import { collectionPlans } from "../collections/plans.js";
import { TYPES as COLLECTION_TYPES, entryKeys } from "../collections/format.js";
import { shelves, shelfOf, hasKind, mediaOf, viewable, classify } from "../types/index.js";

/** Which importer's folder a download saves into. */
export function importerOf(plan) {
  const adapter = plan.source?.adapter;
  if (["web", "wikipedia", "maps", "podcasts", "video", "software"].includes(adapter)) return adapter;
  return `files:${classify(plan.filename || "").type}`;
}

// Libraries made before the app was renamed keep their state under the old name.
const OLD_NAME = "Alexandria";

/** Renames an older library's state folder and updates its guide. Returns true if it did. */
export async function upgradeLegacyLibrary(archiveRoot) {
  const old = path.join(archiveRoot, `.${OLD_NAME.toLowerCase()}`);
  const current = path.join(archiveRoot, ".obelisk");
  try {
    await lstat(old);
  } catch {
    return false;
  }
  try {
    await lstat(current);
    return false;
  } catch {}
  await rename(old, current);
  const guide = path.join(archiveRoot, "ABOUT THIS ARCHIVE.txt");
  try {
    const text = await readFile(guide, "utf8");
    await writeFile(guide, text.replaceAll(`.${OLD_NAME.toLowerCase()}/`, ".obelisk/").replaceAll(OLD_NAME, "Obelisk"));
  } catch {}
  return true;
}

/**
 * What a file, or a package folder macOS shows as one file, is right now: the name,
 * size and change times of everything in it. Any edit changes it, even one that keeps
 * the size and a timestamp someone set by hand (the system sets ctime on every change).
 */
async function fingerprint(target) {
  const entries = [];
  async function walk(file, name) {
    const stats = await lstat(file);
    entries.push(`${name}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`);
    if (stats.isDirectory())
      for (const child of (await readdir(file)).sort()) await walk(path.join(file, child), `${name}/${child}`);
  }
  await walk(target, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** One open archive. Desktop integration lives outside this service. */
export async function openLibrary(
  archiveRoot,
  stateRoot = path.join(archiveRoot, ".obelisk"),
  options = {},
) {
  await mkdir(archiveRoot, { recursive: true });
  archiveRoot = await realpath(archiveRoot);
  await upgradeLegacyLibrary(archiveRoot);
  await writeArchiveGuide(archiveRoot);
  const catalog = openCatalog(stateRoot);
  let downloads, disk = null, indexing = null, closed = false,
    // Files in the folder that are not in the library, as paths relative to the root.
    untracked = [],
    looking = null,
    dating = null,
    // Untracked files seen when the library opened (those wait for Review and add),
    // and each newer one's size and date at the last look.
    known = null,
    adopting = false,
    again = null;
  const settling = new Map(),
    // Downloads other apps haven't finished.
    unfinished = /\.(crdownload|part|partial|download|tmp)$/i;
  // Anyone showing this library is told when anything in it changes, instead of asking.
  const listeners = new Set();
  const changed = () => {
    for (const listener of listeners)
      try {
        listener();
      } catch {}
  };
  for (const name of ["put", "remove", "putJob", "removeJob"]) {
    const write = catalog[name];
    catalog[name] = (...args) => {
      const result = write(...args);
      changed();
      return result;
    };
  }
  /** Free and total space on the drive holding the archive, refreshed every half minute. */
  async function measureDisk() {
    try {
      const info = await statfs(archiveRoot),
        before = disk?.free;
      disk = { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
      if (before !== disk.free) changed();
    } catch {}
    return disk;
  }
  await measureDisk();
  const diskTimer = setInterval(measureDisk, 30000);
  diskTimer.unref?.();
  try {
    // A new index is filled before opening. An existing one opens at once and is
    // brought up to date with the manifests in the background.
    const empty = !catalog.count();
    if (empty) await syncCatalog(catalog, archiveRoot);
    // Folders: laid out for a new library, adopted for an existing one. Opened before
    // the background refresh so an interrupted folder move is settled first.
    const folders = await openFolders({ archiveRoot, catalog, fresh: !catalog.count() });
    if (!empty)
      indexing = syncCatalog(catalog, archiveRoot, { stopped: () => closed }).catch((e) =>
        console.warn("Could not refresh the index:", e.message),
      );
    // Index catch-up, then looking for new files, then filling in dates.
    const settled = Promise.resolve(indexing)
      .then(() => lookForUntracked())
      .then(() => (dating = fillDates().catch(() => {})));
    downloads = createDownloads({
      freeSpace: async () => (await measureDisk())?.free ?? null,
      catalog,
      root: stateRoot,
      archiveRoot,
      onChange: async () => {},
      drivers: { pmtiles: extractMap, ...options.drivers },
      // Collection files go through the browser's connection when the desktop gives one.
      fetch: options.fetch,
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.spacing !== undefined ? { spacing: options.spacing } : {}),
      destinationFor: (plan) => {
        const key = importerOf(plan),
          id = folders.destination(key);
        if (!id) throw new Error("Choose a folder to save into first.");
        return id;
      },
      place: placeDownload,
    });
    /**
     * Where a finished download goes: its folder if it still exists, otherwise
     * Inbox. A podcast episode goes into its show's folder, wherever that now is.
     */
    async function placeDownload(job) {
      let id = job.folderId && folders.get(job.folderId) ? job.folderId : null,
        warning = null;
      if (!id) {
        id = folders.inbox;
        if (job.folderId) warning = "Saved to Inbox because its folder was deleted.";
      }
      if (job.source?.adapter === "podcasts" && job.collection?.id)
        id = await folders.sourceFolder(`podcast:${job.collection.id}`, job.collection.title || "Podcast", id, "podcast");
      // A collection's files go into its own folder, wherever that now is.
      if (job.source?.collection) id = await collectionFolder(job.source.collection);
      changed();
      return { directory: folders.dirOf(id), warning };
    }
    /**
     * A collection's folder: the one that records it, wherever it has been moved;
     * otherwise a new one inside the default folder for its type (Images, Documents/Books),
     * found by name and made if missing. A renamed folder may now mean something else,
     * so names, not folder IDs, decide where a collection starts.
     */
    async function collectionFolder({ id, type, title }) {
      const parent = await folders.pathFolder(COLLECTION_TYPES[type]?.folder || ["Inbox"]);
      return folders.sourceFolder(`collection:${id}`, title, parent);
    }
    // Per collection: which entries this library has been shown, and which files from
    // it were deleted on purpose, so they aren't offered again as new.
    const memoryFile = path.join(stateRoot, "collections.json");
    let memory = {};
    try {
      memory = JSON.parse(await readFile(memoryFile, "utf8")) || {};
    } catch {}
    const remember = async () => {
      const temporary = `${memoryFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(memory));
      await rename(temporary, memoryFile);
    };
    const sources = await createSources({
      root: stateRoot,
      catalog,
      downloads,
    });
    let pending = 0,
      checking = false,
      lastCheck = null;
    const editMetadata = createManifestEditor(catalog, archiveRoot);
    const editTags = createTagEditor(catalog, archiveRoot, editMetadata);
    /**
     * Once per archive: files added before dates were read get theirs now, from
     * their source or from inside the file. Dates someone typed are never replaced.
     */
    async function fillDates() {
      const marker = path.join(stateRoot, "dates-filled");
      try {
        await stat(marker);
        return;
      } catch {}
      const missing = catalog.list().filter((i) => !i.placeholder && !i.created && i.path);
      for (const item of missing) {
        if (closed) return;
        if (checking) await new Promise((resolve) => setTimeout(resolve, 2000));
        const date = sourceDate(item.source) || (await fileDate(path.resolve(archiveRoot, item.path), item.filename));
        if (!date) continue;
        pending++;
        try {
          await editMetadata([item.id], (current) => (current.created ? current : { ...current, created: date }));
        } catch {
        } finally {
          pending--;
        }
      }
      if (!closed) await writeFile(marker, new Date().toISOString()).catch(() => {});
    }
    /** Folder changes wait for checks, and tell the window when they are done. */
    async function guard(task) {
      if (checking) throw new Error("Wait for the archive check.");
      pending++;
      try {
        return await task();
      } finally {
        pending--;
        changed();
      }
    }
    /** Finds files added to the folder by other means. One look at a time. */
    function lookForUntracked() {
      looking ||= findUntracked(catalog, archiveRoot, { stopped: () => closed })
        .then((found) => {
          if (closed) return;
          const before = untracked.join("\n");
          untracked = found;
          if (before !== found.join("\n")) changed();
          if (known) void adopt(found);
          else known = new Set(found);
        })
        .catch((e) => console.warn("Could not look for new files:", e.message))
        .finally(() => (looking = null));
      return looking;
    }
    // Unique per opened archive, so switching archives never looks like "no change".
    const opened = randomUUID(),
      revision = () => `${opened}:${catalog.revision}`;
    let listed = { revision: -1, items: [] };
    function listItems() {
      if (listed.revision !== catalog.revision) {
        // Each item's folder is its item folder's parent; `group` is what its format is.
        const byDir = new Map(folders.list().map((f) => [f.dir, f.id]));
        listed = {
          revision: catalog.revision,
          items: catalog
            .list()
            .filter((i) => !i.placeholder)
            .map((i) => ({
              ...i,
              media: mediaOf(i.filename || ""),
              group: classify(i.filename || "").type,
              folderId: byDir.get(path.posix.dirname(path.posix.dirname(i.path || ""))) || null,
            })),
        };
      }
      return listed.items;
    }
    async function resolveItem(id) {
      const item = catalog.get(id);
      if (!item?.path) throw new Error("This item has no saved file.");
      const filename = await realpath(path.resolve(archiveRoot, item.path));
      if (!filename.startsWith(archiveRoot + path.sep))
        throw new Error("File is outside this archive.");
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("This is not a file.");
      return { item, filename, info };
    }
    /**
     * What importing these paths would do, without copying anything: every file
     * found (folders are walked), where it would be filed, and a starting title.
     */
    async function previewPaths(paths, options = {}) {
      if (options.type && !shelfOf(options.type))
        throw new Error("Unknown file category.");
      if (options.kind && !hasKind(options.type || options.fallback, options.kind))
        throw new Error("Unknown kind for this category.");
      const found = [],
        limit = options.limit || 200,
        // A big file on the library's own drive, where copies can't share storage, may
        // be moved in instead: copying it there takes a long time and doubles its space.
        drive = (await stat(archiveRoot)).dev,
        clones = await canClone(archiveRoot);
      async function add(file, relative = "", depth = 0) {
        if (depth > 20 || found.length >= limit)
          throw new Error(`Choose at most ${limit} files, up to 20 folders deep.`);
        const info = await lstat(file);
        if (info.isSymbolicLink()) return;
        if (info.isDirectory()) {
          if (file.endsWith(".app"))
            throw new Error("Save applications as a ZIP or installer.");
          // A folder macOS shows as one file (an Apple Books EPUB, a Pages document)
          // is kept as one file.
          const bundle = packageOf(file);
          if (bundle) {
            found.push({
              file,
              name: bundle.name,
              bundle: bundle.format,
              relative: relative ? relative.split(path.sep).join("/") : "",
              bytes: await packageSize(file),
              title: path.basename(file).replace(/\.[^.]+$/, ""),
              ...fileTarget(bundle.name, options),
            });
            return;
          }
          for (const child of await readdir(file, { withFileTypes: true })) {
            if (child.name.startsWith(".")) continue;
            await add(path.join(file, child.name), path.join(relative, path.basename(file)), depth + 1);
          }
        } else if (info.isFile()) {
          const name = path.basename(file);
          found.push({
            file,
            name,
            relative: relative ? relative.split(path.sep).join("/") : "",
            bytes: info.size,
            ...(info.dev === drive && !clones && info.size >= 1e9 && !file.startsWith(archiveRoot + path.sep) ? { movable: true } : {}),
            title: name.replace(/\.[^.]+$/, "") || name,
            ...fileTarget(name, options),
          });
        }
      }
      if (!Array.isArray(paths) || paths.length > limit)
        throw new Error(`Choose up to ${limit} files.`);
      for (const file of paths) await add(file);
      return found;
    }
    // Imports under way and the last few finished, shown in Transfers.
    const imports = new Map();
    let toldAt = 0;
    const importing = () => [...imports.values()].some((task) => !["complete", "failed"].includes(task.phase));
    function progressOf(task) {
      return (done, phase) => {
        task.done = done;
        task.phase = phase;
        // A big file reports every few megabytes; the window needs a few updates a second.
        if (Date.now() - toldAt > 250) {
          toldAt = Date.now();
          changed();
        }
      };
    }
    function finishTask(task, result) {
      if (result.error) Object.assign(task, { phase: "failed", error: result.error });
      else Object.assign(task, { phase: "complete", done: task.bytes, itemId: result.item.id });
      const finished = [...imports.values()].filter((t) => ["complete", "failed"].includes(t.phase));
      for (const old of finished.slice(0, -20)) imports.delete(old.id);
      changed();
    }
    /** Copies previewed files in, each with its own shelf, kind, title and tags. */
    async function importEntries(entries) {
      if (checking) throw new Error("Wait for the archive check.");
      pending++;
      const tasks = entries.map((entry) => {
        const task = {
          id: randomUUID(),
          title: entry.title || entry.name || path.basename(entry.file),
          bytes: entry.bytes || 0,
          done: 0,
          phase: "waiting",
          ...(entry.auto ? { auto: true } : {}),
        };
        imports.set(task.id, task);
        return task;
      });
      changed();
      try {
        const results = [];
        for (const [index, entry] of entries.entries()) {
          const task = tasks[index],
            progress = progressOf(task),
            // A file already in the library folder is moved into its own item folder
            // rather than copied, as is one someone chose to move in; a package is
            // zipped, and the original removed after.
            moving = (entry.inPlace && !entry.bundle) || (entry.move && entry.movable),
            temporaryPath = moving ? entry.file : path.join(stateRoot, "downloads", `${randomUUID()}.import`);
          let result;
          try {
            const before = entry.inPlace && entry.bundle && (await fingerprint(entry.file));
            // A copy from another drive is checksummed as it is written. A moved,
            // cloned or zipped file is usable at once; its checksum is read after.
            let sums = { sha256: null, embedded: null };
            if (moving) {
              if (entry.inPlace && !(await realpath(entry.file)).startsWith(archiveRoot + path.sep))
                throw new Error("File is outside this archive.");
            } else {
              await mkdir(path.dirname(temporaryPath), { recursive: true });
              if (entry.bundle) {
                progress(0, "copying");
                await zipPackage(entry.file, temporaryPath, entry.bundle);
              } else sums = await copyIn(entry.file, temporaryPath, progress);
            }
            // Its chosen folder, else the folder its format usually goes to, else Inbox.
            const group = entry.type || classify(entry.name || entry.file).type,
              folderId = (entry.folderId && folders.get(entry.folderId) && entry.folderId) || folders.destination(`files:${group}`) || folders.inbox;
            result = await importFile({
              directory: folders.dirOf(folderId),
              catalog,
              archiveRoot,
              temporaryPath,
              ...sums,
              pending: !sums.sha256,
              filename: entry.name || path.basename(entry.file),
              type: entry.type,
              kind: entry.kind,
              software: entry.type === "software" ? { platform: "unknown", arch: "unknown", offlineTested: false } : undefined,
              title: entry.title || path.basename(entry.file),
              source: { adapter: "import", provider: "Local import", ...(entry.relative ? { folder: entry.relative } : {}) },
            });
            if (!result.duplicate && entry.tags?.length) await editTags([result.item.id], entry.tags, "add");
            if (entry.inPlace && !result.duplicate) {
              // A package's original goes only if it is still the version that was imported.
              const gone = moving || (await fingerprint(entry.file).catch(() => null)) === before;
              if (entry.bundle && gone) await rm(entry.file, { force: true, recursive: true });
              if (gone) {
                const relative = path.relative(archiveRoot, entry.file).split(path.sep).join("/");
                untracked = untracked.filter((f) => f !== relative);
                if (lastCheck) lastCheck.untracked = lastCheck.untracked.filter((f) => f !== relative);
              }
            }
          } catch (e) {
            result = { filename: entry.name || path.basename(entry.file), error: e.message };
          } finally {
            if (!moving) await rm(temporaryPath, { force: true });
          }
          if (result.item?.integrity === "pending") readSoon();
          finishTask(task, result);
          results.push(result);
        }
        return results;
      } finally {
        pending--;
      }
    }
    // One file is read at a time, in the background: first to work out checksums for
    // files moved or cloned in without one, then, during a Verify contents run, to
    // re-read the files confirmed longest ago. Nothing waits on it, and it gives way to
    // imports and checks. A run is remembered, so it carries on after a restart.
    const verifyFile = path.join(stateRoot, "verify.json");
    let reader = null,
      readPaused = false,
      reading = null,
      verifyRun = null,
      readToldAt = 0;
    // Files that changed while being read, or couldn't be: tried again next session.
    const skipped = new Set();
    try {
      verifyRun = JSON.parse(await readFile(verifyFile, "utf8"));
    } catch {}
    const readable = () =>
      catalog.list().filter((i) => !i.placeholder && i.path && !["missing", "ambiguous"].includes(i.fileState));
    function nextToRead() {
      const usable = readable().filter((i) => !skipped.has(i.id)),
        fresh = usable.find((i) => !i.sha256);
      if (fresh) return { item: fresh, verify: false };
      if (!verifyRun) return null;
      let oldest = null;
      for (const i of usable)
        if (!(i.verifiedAt >= verifyRun.startedAt) && (!oldest || (i.verifiedAt || "") < (oldest.verifiedAt || ""))) oldest = i;
      return oldest && { item: oldest, verify: true };
    }
    function readSoon() {
      if (closed || readPaused) return reader;
      reader ||= readAll()
        .catch((e) => console.warn("Could not read files:", e.message))
        .finally(() => {
          reader = reading = null;
          changed();
        });
      return reader;
    }
    async function readAll() {
      await settled;
      while (!closed && !readPaused) {
        // Two reads at once would slow both down.
        if (checking || importing()) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        const next = nextToRead();
        if (!next) break;
        await readOne(next);
      }
      if (verifyRun && !closed && !readPaused && !nextToRead()) {
        verifyRun = null;
        await rm(verifyFile, { force: true }).catch(() => {});
      }
    }
    async function readOne({ item, verify }) {
      let file;
      try {
        file = await realpath(path.resolve(archiveRoot, item.path));
        if (!file.startsWith(archiveRoot + path.sep)) throw new Error(OUTSIDE);
      } catch {
        skipped.add(item.id);
        return;
      }
      const before = await stat(file);
      reading = { id: item.id, title: item.title, bytes: before.size, done: 0, verify };
      changed();
      let sums;
      try {
        sums = await readChecksums(
          file,
          (done) => {
            reading.done = done;
            if (Date.now() - readToldAt > 250) {
              readToldAt = Date.now();
              changed();
            }
          },
          () => closed || readPaused,
        );
      } catch (e) {
        // Paused or closed: read again from the start when it carries on.
        if (!(e instanceof Stopped)) skipped.add(item.id);
        return;
      }
      const after = await stat(file).catch(() => null),
        current = catalog.get(item.id);
      // Moved with its folder while it was read: read again where it is now.
      if (current && current.path !== item.path) return;
      if (!current || !after || !sameStamp(stampOf(before), after)) {
        skipped.add(item.id);
        return;
      }
      const now = new Date().toISOString(),
        stamp = stampOf(after);
      let patch;
      if (!current.sha256)
        patch = {
          sha256: sums.sha256,
          integrity: sums.embedded ? "publisher-verified" : "hashed",
          ...(sums.embedded === false ? { fileState: "damaged" } : {}),
          stamp,
          verifiedAt: now,
        };
      else if (sums.sha256 === current.sha256)
        // Unchanged. A ZIM that fails its own checksum was damaged before it arrived.
        patch = { stamp, verifiedAt: now, fileState: sums.embedded === false ? "damaged" : current.fileState === "damaged" ? "ok" : current.fileState || "ok" };
      // Different contents. With the size and date it had when last confirmed, nothing
      // saved over it, so the drive damaged it; otherwise someone changed it.
      else if (sameStamp(current.stamp, after)) patch = { fileState: "damaged", observedSha256: sums.sha256, verifiedAt: now };
      else patch = { fileState: "modified", integrity: "changed", observedSha256: sums.sha256, observedBytes: after.size, verifiedAt: now };
      pending++;
      try {
        await editMetadata([item.id], (latest) => ({ ...latest, ...patch }), { edited: false });
      } catch {
        skipped.add(item.id);
      } finally {
        pending--;
        reading = null;
        changed();
      }
    }
    // What was left unread when it last closed carries on once it has opened.
    void settled.then(() => readSoon());
    // Files put into the library folder while it is open are added where they were
    // put, once they have stopped changing. Those already there when it opened wait
    // for Review and add, and so does anything that couldn't be added.
    async function adopt(found) {
      if (adopting || closed) return;
      adopting = true;
      try {
        const ready = new Map();
        let waiting = false;
        for (const relative of found) {
          if (known.has(relative) || unfinished.test(relative)) continue;
          const dir = path.posix.dirname(relative),
            // A folder made in Finder isn't one of the library's folders until it reopens.
            folderId = dir === "." ? folders.inbox : folders.list().find((f) => f.dir === dir)?.id;
          if (!folderId) continue;
          let info;
          try {
            info = await lstat(path.join(archiveRoot, relative));
          } catch {
            settling.delete(relative);
            continue;
          }
          // Unchanged since the last look, a few seconds ago: no longer being copied in.
          const mark = `${info.size}:${info.mtimeMs}`;
          if (settling.get(relative) !== mark || checking || pending) {
            settling.set(relative, mark);
            waiting = true;
          } else ready.set(path.join(archiveRoot, relative), { relative, folderId });
        }
        if (ready.size) {
          for (const { relative } of ready.values()) {
            known.add(relative);
            settling.delete(relative);
          }
          const listed = await previewPaths([...ready.keys()], { limit: 1000 });
          await importEntries(listed.map((file) => ({ ...file, inPlace: true, auto: true, folderId: ready.get(file.file)?.folderId })));
        }
        if (waiting && !closed) {
          clearTimeout(again);
          again = setTimeout(() => void lookForUntracked(), 3000);
          again.unref?.();
        }
      } catch (e) {
        console.warn("Could not add new files:", e.message);
      } finally {
        adopting = false;
      }
    }
    /** What the background reader is doing, and how much of the library is confirmed. */
    function readingState() {
      const all = readable(),
        oldest = all.reduce((at, i) => (i.verifiedAt && (!at || i.verifiedAt < at) ? i.verifiedAt : at), null);
      return {
        current: reading,
        paused: readPaused,
        waiting: all.filter((i) => !i.sha256).length,
        verified: all.filter((i) => i.verifiedAt).length,
        total: all.length,
        oldest,
        damaged: all.filter((i) => i.fileState === "damaged").length,
        run: verifyRun && {
          startedAt: verifyRun.startedAt,
          done: all.filter((i) => i.verifiedAt >= verifyRun.startedAt).length,
          bytes: all.reduce((n, i) => n + (i.bytes || 0), 0),
          read: all.reduce((n, i) => n + (i.verifiedAt >= verifyRun.startedAt ? i.bytes || 0 : 0), 0),
        },
      };
    }
    /** Which entries of each collection this library holds, by entry key. */
    function savedEntries() {
      const saved = new Map();
      for (const item of catalog.list()) {
        const from = item.source?.collection;
        if (!from?.id || item.placeholder) continue;
        if (!saved.has(from.id)) saved.set(from.id, new Map());
        saved.get(from.id).set(from.key, item.id);
      }
      return saved;
    }
    return {
      archiveRoot,
      catalog,
      downloads,
      sources,
      collections: {
        /**
         * Where this library stands with each collection: what it holds, what's on its
         * way, what failed and why, and what's new since it last looked.
         */
        status(list) {
          const saved = savedEntries(),
            jobs = new Map();
          for (const job of catalog.jobs()) {
            const from = job.source?.collection;
            if (from?.id && job.status !== "complete") jobs.set(`${from.id}|${from.key}`, job);
          }
          return Object.fromEntries(
            list.map((c) => {
              const have = saved.get(c.id) || new Map(),
                m = memory[c.id],
                entries = {};
              for (const entry of c.entries)
                for (const key of entryKeys(c, entry)) {
                  const job = jobs.get(`${c.id}|${key}`);
                  if (have.has(key)) entries[key] = { state: "saved", itemId: have.get(key) };
                  else if (job)
                    entries[key] = {
                      state: job.status,
                      failure: job.failure || null,
                      error: job.error || null,
                      retryAt: job.retryAt || null,
                      bytes: job.bytes || 0,
                      total: job.total || null,
                    };
                  else if (m && !m.seen.includes(key)) entries[key] = { state: "new" };
                }
              return [c.id, { started: !!m, folder: folders.list().find((f) => f.source?.key === `collection:${c.id}`)?.id || null, entries }];
            }),
          );
        },
        /**
         * Saves a collection's entries (all of them without `keys`). Entries already in
         * the library are skipped and stopped ones pick up where they left off, so
         * saving again only ever fills in what's missing.
         */
        async save(c, keys = null) {
          const have = savedEntries().get(c.id) || new Map(),
            plans = collectionPlans(c, keys).filter((p) => !have.has(p.source.collection.key));
          const queued = new Set(catalog.jobs().filter((j) => j.source?.collection?.id === c.id).map((j) => j.source.collection.key)),
            fresh = plans.filter((p) => !queued.has(p.source.collection.key));
          // All of it has to fit, not just the first few files.
          await downloads.checkSpace(fresh.reduce((n, p) => n + (p.expectedBytes || 0), 0));
          const folderId = plans.length ? await collectionFolder({ id: c.id, type: c.type, title: c.title }) : null;
          (memory[c.id] ||= { seen: [] }).seen = c.entries.flatMap((e) => entryKeys(c, e));
          await remember();
          changed();
          return downloads.addPlans(plans.map((p) => ({ ...p, folderId })));
        },
        /**
         * Resumes a collection's stopped downloads with what the collection says now: a
         * link fixed since they started is followed, and its new checksum expected.
         */
        async resume(c) {
          const plans = new Map(collectionPlans(c).map((p) => [p.source.collection.key, p]));
          for (const job of catalog.jobs()) {
            const key = job.source?.collection?.id === c.id && job.source.collection.key,
              plan = key && plans.get(key);
            if (!plan || !["paused", "failed", "waiting"].includes(job.status) || plan.url === job.url) continue;
            // A different file: what was downloaded so far belongs to the old one.
            catalog.putJob({ ...job, url: plan.url, expectedBytes: plan.expectedBytes, expectedSha256: plan.expectedSha256, total: plan.expectedBytes || null, bytes: 0, validator: null, source: { ...job.source, downloadUrl: plan.url } });
          }
          await downloads.group(`collection:${c.id}`, "resume");
        },
        /** Marks a collection's entries as seen without saving anything. */
        async seen(c) {
          (memory[c.id] ||= { seen: [] }).seen = c.entries.flatMap((e) => entryKeys(c, e));
          await remember();
        },
      },
      resolveItem,
      /** One ID returns one item; a list applies the same patch to each file. */
      async updateMetadata(id, values) {
        if (checking) throw new Error("Wait for the archive check.");
        const patch = metadataPatch(values),
          many = Array.isArray(id);
        if (many && ["title", "description"].some((k) => Object.hasOwn(patch, k)))
          throw new Error("Titles and descriptions are edited one file at a time.");
        pending++;
        try {
          const items = await editMetadata(many ? id : [id], (item) =>
            applyMetadata(item, patch),
          );
          return many ? items : items[0];
        } finally {
          pending--;
        }
      },
      /** Renames a tag everywhere; an empty replacement removes it. */
      async renameTag(from, to = "") {
        if (checking) throw new Error("Wait for the archive check.");
        const [old] = normalizeTags([from]),
          [next] = normalizeTags([to]);
        if (!old) throw new Error("Choose a tag.");
        const ids = catalog
          .list()
          .filter((i) => i.tags?.includes(old))
          .map((i) => i.id);
        if (!ids.length || old === next) return 0;
        pending++;
        try {
          for (let n = 0; n < ids.length; n += 1000)
            await editMetadata(ids.slice(n, n + 1000), (item) => ({
              ...item,
              tags: normalizeTags([
                ...item.tags.filter((t) => t !== old),
                ...(next ? [next] : []),
              ]),
            }));
          return ids.length;
        } finally {
          pending--;
        }
      },
      /**
       * Removes files from the archive. `dispose` receives each absolute path
       * (the desktop passes the system trash); nothing is unlinked here.
       */
      async removeItems(ids, dispose) {
        if (checking) throw new Error("Wait for the archive check.");
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          ids.some((id) => typeof id !== "string")
        )
          throw new Error("Select between 1 and 1,000 files.");
        if (typeof dispose !== "function")
          throw new Error("No trash is available.");
        pending++;
        try {
          const removed = [];
          for (const id of new Set(ids)) {
            const item = catalog.get(id);
            if (!item?.path) continue;
            const directory = path.dirname(path.resolve(archiveRoot, item.path));
            let real;
            try {
              real = await realpath(directory);
            } catch {
              // The folder is already gone; only the index entry remains.
              catalog.remove(id);
              removed.push(id);
              continue;
            }
            if (!real.startsWith(archiveRoot + path.sep))
              throw new Error("File is outside this archive.");
            let manifest = null;
            try {
              manifest = JSON.parse(
                await readFile(path.join(real, "item.json"), "utf8"),
              );
            } catch {}
            // A manifest kept apart from its file goes too, or it would bring the item back.
            if (item.manifestPath) {
              const apart = path.resolve(archiveRoot, item.manifestPath);
              try {
                const at = await realpath(apart);
                if (at.startsWith(archiveRoot + path.sep) && path.dirname(at) !== real &&
                    JSON.parse(await readFile(at, "utf8")).id === id)
                  await dispose(at);
              } catch (e) {
                if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
              }
            }
            const owned = manifest?.id === id,
              names = (await readdir(real)).filter((n) => n !== ".DS_Store"),
              expected = [path.basename(item.path), ...(owned ? ["item.json"] : [])];
            // A folder holding only this item goes whole; anything else stays put.
            if (owned && names.every((n) => expected.includes(n)))
              await dispose(real);
            else
              for (const name of expected) {
                const target = path.join(real, name);
                try {
                  if ((await lstat(target)).isFile()) await dispose(target);
                } catch (e) {
                  if (e.code !== "ENOENT") throw e;
                }
              }
            catalog.remove(id);
            removed.push(id);
          }
          return removed;
        } finally {
          pending--;
        }
      },
      async updateTags(ids, tags, mode) {
        if (checking) throw new Error("Wait for the archive check.");
        pending++;
        try {
          return await editTags(ids, tags, mode);
        } finally {
          pending--;
        }
      },
      async check() {
        if (checking) throw new Error("Wait for the archive check.");
        if (importing()) throw new Error("Wait for imports to finish before checking. They're in Transfers.");
        if (catalog.jobs().some((j) => ["queued", "downloading", "verifying", "pausing"].includes(j.status)))
          throw new Error("Wait for transfers to finish before checking.");
        if (pending) throw new Error("Wait for the current change to finish before checking.");
        checking = true;
        changed();
        try {
          lastCheck = await scanArchive(catalog, archiveRoot);
          untracked = lastCheck.untracked;
          return lastCheck;
        } finally {
          checking = false;
          changed();
        }
      },
      async accept(id) {
        if (checking) throw new Error("Wait for the archive check.");
        const item = await acceptCurrentFile(catalog, archiveRoot, id);
        if (lastCheck)
          lastCheck.changes = lastCheck.changes.filter(
            (change) => change.id !== id,
          );
        return item;
      },
      async saveSoftwareNotes(id, notes) {
        if (checking) throw new Error("Wait for the archive check.");
        pending++;
        try {
          return (
            await editMetadata([id], (item) => {
              if (item.type !== "software")
                throw new Error("Select a software package.");
              return {
                ...item,
                software: {
                  ...item.software,
                  platform: String(notes.platform || "unknown"),
                  arch: String(notes.arch || "unknown"),
                  offlineTested: notes.offlineTested === true,
                  testedAt: notes.offlineTested
                    ? new Date().toISOString()
                    : null,
                },
              };
            })
          )[0];
        } finally {
          pending--;
        }
      },
      busy: () =>
        checking ||
        pending > 0 ||
        catalog
          .jobs()
          .some((j) =>
            ["queued", "downloading", "verifying", "pausing"].includes(
              j.status,
            ),
          ),
      /**
       * Everything the window shows. Items are left out when the caller already has
       * this revision, since they are most of the size and rarely change.
       */
      state: (since) => ({
        archiveRoot,
        revision: revision(),
        untracked: untracked.length,
        lastCheck,
        checking,
        disk,
        name:
          path.basename(archiveRoot) === "archive"
            ? "Demo archive"
            : path.basename(archiveRoot),
        // `media` says how a file opens; it follows the format, not the shelf.
        ...(since === revision() ? {} : { items: listItems() }),
        // Each shelf says which formats open inside the app, for the Import page.
        shelves: shelves.map((shelf) => ({
          ...shelf,
          opens: viewable(shelf.id),
          kinds: shelf.kinds.map((k) => ({ ...k, opens: viewable(shelf.id, k.id) })),
        })),
        folders: folders.list(),
        inbox: folders.inbox,
        destinations: folders.destinations(),
        jobs: catalog.jobs(),
        imports: [...imports.values()],
        reading: readingState(),
        platform: process.platform,
        arch: process.arch,
      }),
      async readText(id) {
        const { filename, info } = await resolveItem(id);
        if (info.size > 2 * 1024 * 1024)
          throw new Error(
            "Text preview is limited to 2 MB. Open the file in another application.",
          );
        if (!/\.(txt|md|csv|json|html?|css|js|xml|log)$/i.test(filename))
          throw new Error("This format does not have a text preview.");
        return readFile(filename, "utf8");
      },
      previewPaths,
      importEntries,
      /** The background reader: pause and resume it, start or stop a Verify contents run. */
      reading: {
        pause() {
          readPaused = true;
          changed();
        },
        resume() {
          readPaused = false;
          skipped.clear();
          readSoon();
          changed();
        },
        async verify() {
          if (!verifyRun) {
            verifyRun = { startedAt: new Date().toISOString() };
            await writeJson(verifyFile, verifyRun);
          }
          readPaused = false;
          readSoon();
          changed();
        },
        async stopVerify() {
          verifyRun = null;
          await rm(verifyFile, { force: true });
          changed();
        },
        /** Resolves once there is nothing left to read for now. */
        idle: () => readSoon() || Promise.resolve(),
      },
      /** Forgets finished imports, as Clear does for finished downloads. */
      clearImports() {
        for (const task of imports.values()) if (["complete", "failed"].includes(task.phase)) imports.delete(task.id);
        changed();
      },
      /**
       * Files the last check found inside the archive folder but not in the library,
       * still there and still plain files.
       */
      lookForUntracked,
      /** Resolves once the work started on opening has finished. */
      settled: () => settled,
      async untrackedPaths() {
        const root = await realpath(archiveRoot),
          found = [];
        for (const relative of untracked) {
          const file = path.resolve(root, relative);
          if (!file.startsWith(root + path.sep)) continue;
          try {
            const info = await lstat(file);
            if (info.isFile() || (info.isDirectory() && packageOf(file))) found.push(file);
          } catch {}
        }
        return found;
      },
      async importPaths(paths, options = {}) {
        if (checking) throw new Error("Wait for the archive check.");
        return importEntries(await previewPaths(paths, options));
      },
      /**
       * Refiles items on another shelf. An item folder that holds only the file
       * and its manifest moves with it; anything else stays where it is and only
       * the label changes. The kind is cleared: it belonged to the old shelf.
       */
      /** Moves files into a folder; each file's item folder moves with it. */
      async moveItems(ids, folderId) {
        if (checking) throw new Error("Wait for the archive check.");
        if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some((id) => typeof id !== "string"))
          throw new Error("Select between 1 and 5,000 files.");
        pending++;
        try {
          return await folders.moveItems(ids, folderId);
        } finally {
          pending--;
          changed();
        }
      },
      folders: {
        list: () => folders.list(),
        create: (parentId, name, icon) => guard(() => folders.create(parentId, name, icon)),
        rename: (id, name) => guard(() => folders.rename(id, name)),
        setIcon: (id, icon) => guard(() => folders.setIcon(id, icon)),
        move: (id, parentId) => guard(() => folders.move(id, parentId)),
        order: (parentId, ids) => guard(() => folders.order(parentId, ids)),
        /** Deletes a folder: its contents move up (`keep`) or go to `trash` with it. */
        remove: (id, { keep, trash }) =>
          guard(() =>
            folders.remove(id, {
              keep,
              trash,
              // A download still heading into this folder (or one inside it) must land somewhere.
              busy: (dir) =>
                catalog.jobs().some((j) => {
                  if (["complete", "failed"].includes(j.status) || !j.folderId) return false;
                  const at = folders.dirOf(j.folderId);
                  return at !== null && (at === dir || at.startsWith(dir + "/"));
                }),
            }),
          ),
        setDestination: (key, id) => guard(() => folders.setDestination(key, id)),
        rescan: () => guard(() => folders.rescan()),
      },
      /** Calls `listener` after any change; returns a function that stops it. */
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {
        closed = true;
        listeners.clear();
        clearTimeout(again);
        await reader;
        await looking;
        await dating;
        await indexing;
        clearInterval(diskTimer);
        await downloads.stop();
        catalog.close();
      },
    };
  } catch (e) {
    closed = true;
    await indexing;
    await downloads?.stop();
    catalog.close();
    throw e;
  }
}
