import path from "node:path";
import {
  readdir,
  readFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { hashFile, writeJson, stampOf, sameStamp } from "./archive.js";
import { packageOf } from "./bundle.js";
// A manifest being saved: written beside it under a temporary name, then renamed over it.
const saving = (name) => /^(item|folder)\.json\.[0-9a-f-]{36}\.tmp$/.test(name);
// Never follow symlinks, delete content, or replace the original checksum. A file is
// read only when its size or date has changed, or to find where it moved.
export async function scanArchive(catalog, root) {
  const files = [],
    manifests = [],
    errors = [],
    // Package folders (an Apple Books EPUB) are one untracked thing, not their contents.
    packages = [];
  let entries = 0;
  async function walk(dir, depth = 0) {
    if (depth > 20) return;
    for (const child of await readdir(dir, { withFileTypes: true })) {
      // Each file is a folder plus its manifest, so this allows well over a million files.
      if (++entries > 5_000_000)
        throw new Error(
          "Archive check reached 5 million entries. Split this archive into smaller folders.",
        );
      if (
        child.name.startsWith(".") ||
        ["node_modules", "Library"].includes(child.name)
      )
        continue;
      const file = path.join(dir, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (packageOf(file)) packages.push(file);
        else if (!child.name.endsWith(".app")) await walk(file, depth + 1);
      } else if (child.isFile()) {
        if (child.name === "item.json") {
          try {
            const item = JSON.parse(await readFile(file, "utf8"));
            if (!item.placeholder && item.schemaVersion === 1 && typeof item.id === "string" && typeof item.filename === "string" && typeof item.path === "string")
              manifests.push({ file, item });
          } catch {
            errors.push(path.relative(root, file));
          }
        } else if (!["ABOUT THIS ARCHIVE.txt", "folder.json"].includes(child.name) && !saving(child.name)) files.push(file);
      }
    }
  }
  await walk(root);
  const fileSet = new Set(files),
    claimed = new Set(),
    hashes = new Map(),
    // Size, date and file ID of everything found: what most of the check runs on.
    infos = new Map();
  for (const file of files) infos.set(file, await lstat(file));
  const hash = async (file) => {
    if (!hashes.has(file)) hashes.set(file, await hashFile(file));
    return hashes.get(file);
  };
  const manifestById = new Map();
  const duplicateIds = new Set();
  for (const m of manifests) {
    if (manifestById.has(m.item.id)) duplicateIds.add(m.item.id);
    else manifestById.set(m.item.id, m);
  }
  const items = new Map(
    catalog
      .list()
      .filter((i) => !i.placeholder)
      .map((i) => [i.id, i]),
  );
  for (const m of manifests)
    if (!items.has(m.item.id)) items.set(m.item.id, m.item);
  const changes = [];
  // Whether a file found elsewhere is this item's: the same file moved (same ID and
  // size), or failing that the same contents. Only same-size files are ever read.
  const isIt = async (old, file) =>
    infos.get(file).size === old.bytes &&
    ((old.stamp?.ino && infos.get(file).ino === old.stamp.ino) || (old.sha256 && (await hash(file)) === old.sha256));
  for (const old of items.values()) {
    if(typeof old.path!=="string"||typeof old.filename!=="string"){changes.push({id:old.id,title:old.title,status:"invalid metadata"});continue;}
    const m = manifestById.get(old.id);
    let file;
    const expected = path.resolve(root, old.path || "");
    if (duplicateIds.has(old.id)) {
      catalog.put({ ...old, fileState: "ambiguous" });
      changes.push({ id: old.id, title: old.title, status: "ambiguous" });
      continue;
    }
    if (fileSet.has(expected)) file = expected;
    if (!file && m) {
      const nearby = path.resolve(
        path.dirname(m.file),
        path.basename(old.filename),
      );
      if (fileSet.has(nearby)) file = nearby;
      else {
        const candidates = files.filter(
          (f) => path.dirname(f) === path.dirname(m.file),
        );
        if (candidates.length === 1 && (await isIt(old, candidates[0]))) file = candidates[0];
      }
    }
    if (!file) {
      const matches = [];
      for (const candidate of files)
        if (!claimed.has(candidate) && (await isIt(old, candidate))) matches.push(candidate);
      if (matches.length === 1) file = matches[0];
    }
    if (!file) {
      catalog.put({ ...old, fileState: "missing" });
      changes.push({ id: old.id, title: old.title, status: "missing" });
      continue;
    }
    claimed.add(file);
    const info = infos.get(file),
      relative = path.relative(root, file).split(path.sep).join("/"),
      unchanged = sameStamp(old.stamp, info);
    // Contents are read only when the size and date no longer say they're the same.
    // A file without a checksum yet is left to the background reader; one from before
    // stamps were kept gets one now, and Verify contents reads it later.
    let observed = null,
      same;
    if (!old.sha256 || unchanged || (!old.stamp && info.size === old.bytes)) same = true;
    else if (info.size !== old.bytes) same = false;
    else same = (observed = await hash(file)) === old.sha256;
    const status = !same
      ? "modified"
      : old.fileState === "damaged" && unchanged
        ? "damaged"
        : relative !== old.path
          ? "moved"
          : "ok";
    const item = {
      ...old,
      path: relative,
      filename: path.basename(file),
      fileState: status === "moved" ? "ok" : status,
      observedBytes: info.size,
      ...(observed ? { observedSha256: observed } : {}),
      ...(same ? { stamp: stampOf(info) } : {}),
    };
    if (status === "modified") {
      item.integrity = "changed";
      if (item.software)
        item.software = {
          ...item.software,
          offlineTested: false,
          testedAt: null,
        };
    }
    // A file found apart from its manifest records where the manifest is.
    if (m) {
      if (path.dirname(m.file) === path.dirname(file)) delete item.manifestPath;
      else item.manifestPath = path.relative(root, m.file).split(path.sep).join("/");
    }
    // Only what changed is written: a check of a big library touches few files.
    if (JSON.stringify(item) !== JSON.stringify(old)) {
      item.checkedAt = new Date().toISOString();
      if (m) await writeJson(m.file, item);
      catalog.put(item);
    }
    if (status !== "ok")
      changes.push({ id: item.id, title: item.title, status, path: relative });
  }
  return {
    checkedAt: new Date().toISOString(),
    changes,
    untracked: [...files.filter((f) => !claimed.has(f)), ...packages]
      .map((f) => path.relative(root, f).split(path.sep).join("/")),
    errors,
  };
}
export async function acceptCurrentFile(catalog, root, id) {
  const old = catalog.get(id);
  if (!old || old.fileState !== "modified")
    throw new Error("Check the archive first and select a modified file.");
  const file = await realpath(path.resolve(root, old.path));
  if (!file.startsWith(root + path.sep))
    throw new Error("File is outside the archive.");
  const info = await lstat(file),
    sha256 = await hashFile(file);
  const item = {
    ...old,
    previousVersions: [
      ...(old.previousVersions || []),
      { sha256: old.sha256, bytes: old.bytes, recordedAt: old.acquiredAt },
    ].slice(-20),
    sha256,
    bytes: info.size,
    stamp: stampOf(info),
    verifiedAt: new Date().toISOString(),
    fileState: "ok",
    integrity: "hashed",
    acceptedAt: new Date().toISOString(),
  };
  const manifest = await realpath(
    path.resolve(
      root,
      old.manifestPath || path.join(path.dirname(old.path), "item.json"),
    ),
  );
  if (!manifest.startsWith(root + path.sep))
    throw new Error("Manifest is outside the archive.");
  await writeJson(manifest, item);
  catalog.put(item);
  return item;
}

/**
 * Files in the archive folder that belong to no item, without hashing anything, so
 * it is cheap enough to run on every launch. A file is claimed by the index or by a
 * manifest beside it (an item folder moved in Finder still claims its file).
 */
export async function findUntracked(catalog, root, { stopped = () => false } = {}) {
  const claimed = new Set();
  for (const item of catalog.list())
    if (typeof item.path === "string") claimed.add(path.resolve(root, item.path));
  const files = [];
  let entries = 0;
  async function walk(dir, depth = 0) {
    if (depth > 20 || stopped()) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(children.map((c) => c.name));
    if (names.has("item.json"))
      try {
        const item = JSON.parse(await readFile(path.join(dir, "item.json"), "utf8"));
        if (typeof item.filename === "string") claimed.add(path.join(dir, item.filename));
      } catch {}
    for (const child of children) {
      if (++entries > 5_000_000 || stopped()) return;
      if (child.name.startsWith(".") || ["node_modules", "Library"].includes(child.name)) continue;
      const file = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (packageOf(file)) files.push(file);
        else if (!child.name.endsWith(".app")) await walk(file, depth + 1);
      } else if (child.isFile() && !["item.json", "folder.json", "ABOUT THIS ARCHIVE.txt"].includes(child.name) && !saving(child.name))
        files.push(file);
    }
  }
  await walk(root);
  return files
    .filter((file) => !claimed.has(file))
    .map((file) => path.relative(root, file).split(path.sep).join("/"));
}
