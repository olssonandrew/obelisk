import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";

test("imports are listed first, then copied with each file's own shelf, kind, title and tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-import-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    await mkdir(path.join(root, "Trip"));
    await writeFile(path.join(root, "Trip", "harbour.mp3"), "not really audio");
    await writeFile(path.join(root, "Trip", "notes.txt"), "notes");
    const listed = await library.previewPaths([path.join(root, "Trip")]);
    assert.deepEqual(listed.map((f) => [f.name, f.type, f.title, f.relative]).sort(), [["harbour.mp3", "audio", "harbour", "Trip"], ["notes.txt", "document", "notes", "Trip"]]);
    assert.equal(library.state().items.length, 0, "listing copies nothing");
    const harbour = listed.find((f) => f.name === "harbour.mp3");
    const [result] = await library.importEntries([{ ...harbour, kind: "recording", title: "Harbour at dawn", tags: ["coast"] }]);
    const item = library.catalog.get(result.item.id);
    assert.equal(item.title, "Harbour at dawn");
    assert.equal(item.kind, "recording");
    assert.deepEqual(item.tags, ["coast"]);
    assert.equal(item.source.folder, "Trip");
    assert.equal(library.state().items.length, 1, "only the confirmed file was imported");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled transfer stops, leaves no partial file, and stays gone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-cancel-"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": "10000000" });
    res.write(Buffer.alloc(200000));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const library = await openLibrary(path.join(root, "archive"), root);
  try {
    const job = library.downloads.add({ url: `http://127.0.0.1:${server.address().port}/big.bin`, title: "Big" });
    for (let i = 0; i < 100 && library.catalog.job(job.id)?.bytes < 100000; i++) await new Promise((r) => setTimeout(r, 20));
    await library.downloads.cancel(job.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(library.catalog.job(job.id), null);
    assert.deepEqual((await readdir(path.join(root, "downloads"))).filter((f) => f.startsWith(job.id)), []);
  } finally {
    server.closeAllConnections();
    server.close();
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a download that would not fit waits before it starts", async () => {
  const { createDownloads } = await import("../packages/core/downloads.js");
  const { openCatalog } = await import("../packages/core/catalog.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-space-"));
  const catalog = openCatalog(root);
  let ran = false;
  const downloads = createDownloads({ catalog, root, archiveRoot: path.join(root, "archive"), onChange: async () => {}, freeSpace: async () => 2 * 1024 ** 3,
    drivers: { fixture: async () => { ran = true; } } });
  try {
    const job = downloads.addPlan({ url: "https://example.org/big.zim", filename: "big.zim", title: "Big", driver: "fixture", expectedBytes: 5 * 1024 ** 3 });
    // It waits, paused, rather than failing: freeing space and resuming carries on.
    for (let i = 0; i < 50 && catalog.job(job.id).status !== "paused"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(catalog.job(job.id).status, "paused");
    assert.match(catalog.job(job.id).error, /Not enough disk space\. This needs 5\.4 GB; 2\.1 GB is free\./);
    assert.equal(ran, false);
  } finally {
    await downloads.stop();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("files dropped into the archive folder are found by a check and added where they are", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-untracked-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    await mkdir(path.join(library.archiveRoot, "Images"), { recursive: true });
    const stray = path.join(library.archiveRoot, "Images", "sunset.jpg");
    await writeFile(stray, "not really a photo");
    // Found without a full check; an item folder renamed in Finder is not mistaken for new.
    const [moved] = await library.importPaths([await writeFile(path.join(root, "kept.txt"), "kept").then(() => path.join(root, "kept.txt"))]);
    await rename(path.dirname(path.join(library.archiveRoot, moved.item.path)), path.join(library.archiveRoot, "Documents", "Renamed"));
    await library.lookForUntracked();
    assert.equal(library.state().untracked, 1);
    assert.deepEqual((await library.check()).untracked, ["Images/sunset.jpg"]);
    const paths = await library.untrackedPaths();
    const [file] = await library.previewPaths(paths, { limit: 1000 });
    const [result] = await library.importEntries([{ ...file, inPlace: true, tags: ["found"] }]);
    assert.equal(result.item.title, "sunset");
    assert.deepEqual(library.catalog.get(result.item.id).tags, ["found"]);
    const images = await readdir(path.join(library.archiveRoot, "Images"));
    assert.ok(images.includes(path.dirname(result.item.path).split("/").pop()), "it gets an item folder");
    assert.ok(!images.includes("sunset.jpg"), "and is no longer loose");
    assert.deepEqual(library.state().lastCheck.untracked, [], "the report forgets it at once");
    assert.deepEqual((await library.check()).untracked, []);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("folders macOS shows as one file (Apple Books EPUBs) import as one standard file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-package-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    const book = path.join(root, "Shelf", "Walden.epub");
    await mkdir(path.join(book, "META-INF"), { recursive: true });
    await mkdir(path.join(book, "OEBPS"));
    await writeFile(path.join(book, "mimetype"), "application/epub+zip");
    await writeFile(path.join(book, "META-INF", "container.xml"), "<container/>");
    await writeFile(path.join(book, "OEBPS", "chapter.xhtml"), "<html>Chapter</html>".repeat(50));
    const listed = await library.previewPaths([path.join(root, "Shelf")]);
    assert.deepEqual(listed.map((f) => [f.name, f.type, f.kind, f.title]), [["Walden.epub", "document", "book", "Walden"]]);
    const [result] = await library.importEntries(listed);
    const bytes = await readFile(path.join(library.archiveRoot, result.item.path));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.toString("latin1", 30, 38), "mimetype", "mimetype comes first");
    assert.equal(bytes.readUInt16LE(8), 0, "and is stored uncompressed");
    assert.equal(bytes.toString("latin1", 38, 58), "application/epub+zip");
    const listing = execFileSync("unzip", ["-l", path.join(library.archiveRoot, result.item.path)], { encoding: "utf8" });
    assert.match(listing, /OEBPS\/chapter\.xhtml/);
    // Dropped into the archive folder, it is one new file, not a folder of parts.
    await rename(book, path.join(library.archiveRoot, "Walden copy.epub"));
    await library.lookForUntracked();
    assert.equal(library.state().untracked, 1);
    assert.deepEqual((await library.check()).untracked, ["Walden copy.epub"]);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an import is usable at once, shows its progress, and is read once for its checksum", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-progress-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    const bytes = Buffer.alloc(9 * 1024 ** 2, 7),
      source = path.join(root, "atlas.zim");
    await writeFile(source, bytes);
    const seen = [];
    library.onChange(() => {
      const { imports, reading } = library.state();
      for (const task of imports) seen.push(`${task.phase}:${task.done}`);
      if (reading.current) seen.push(`reading:${reading.current.done}`);
    });
    const [result] = await library.importPaths([source]);
    assert.deepEqual(await readFile(path.join(library.archiveRoot, result.item.path)), bytes, "it's there before it's checked");
    // Cloned on the same drive, its checksum is read in the background; copied, as it's written.
    assert.equal(result.item.integrity, result.item.sha256 ? "hashed" : "pending");
    await library.reading.verify();
    await library.reading.idle();
    const item = library.catalog.get(result.item.id);
    assert.equal(item.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(item.integrity, "hashed");
    assert.ok(item.verifiedAt && item.stamp.size === bytes.length);
    assert.ok(seen.some((s) => /^(copying|reading):[1-9]/.test(s)), "progress is reported along the way");
    const [task] = library.state().imports;
    assert.deepEqual([task.title, task.phase, task.itemId], ["atlas", "complete", result.item.id]);
    assert.deepEqual(await readFile(source), bytes, "the original stays");
    assert.deepEqual(await readdir(path.join(library.archiveRoot, ".obelisk", "downloads")), [], "nothing is left behind");
    library.clearImports();
    assert.deepEqual(library.state().imports, []);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a file put in a library folder while it is open is moved into place, not copied", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-adopt-"));
  await mkdir(path.join(root, "archive"), { recursive: true });
  await writeFile(path.join(root, "archive", "older.txt"), "here before it opened");
  const library = await openLibrary(path.join(root, "archive"));
  try {
    await library.settled();
    const folder = library.state().folders.find((f) => f.name === "Books") || library.state().folders.find((f) => f.dir);
    const placed = path.join(library.archiveRoot, folder.dir, "wikipedia.zim");
    await writeFile(placed, "pretend encyclopedia");
    const { ino } = await stat(placed);
    // First look: noticed. Next look, unchanged: added.
    await library.lookForUntracked();
    assert.equal(library.state().items.length, 0, "a file still arriving is left alone");
    for (let i = 0; i < 100 && !library.state().items.length; i++) {
      await library.lookForUntracked();
      await new Promise((r) => setTimeout(r, 20));
    }
    const [item] = library.state().items;
    assert.equal(item.folderId, folder.id, "it stays in the folder it was put in");
    const saved = path.join(library.archiveRoot, item.path);
    assert.equal(await readFile(saved, "utf8"), "pretend encyclopedia");
    assert.equal((await stat(saved)).ino, ino, "the same file, moved");
    assert.ok(!(await readdir(path.join(library.archiveRoot, folder.dir))).includes("wikipedia.zim"));
    assert.ok(library.state().imports.some((t) => t.auto && t.phase === "complete"));
    // What was already loose when the library opened waits to be reviewed.
    assert.deepEqual(await library.untrackedPaths(), [path.join(library.archiveRoot, "older.txt")]);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a big file chosen to be moved in is checked, then moved, never copied", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-move-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    const source = path.join(root, "Wikipedia", "wikipedia_en_all.zim");
    await mkdir(path.dirname(source));
    await writeFile(source, "pretend encyclopedia");
    const { ino } = await stat(source);
    const [file] = await library.previewPaths([source]);
    // Only the listing may say a file can be moved; asking isn't enough.
    const [copied] = await library.importEntries([{ ...file, move: true }]);
    assert.equal(await readFile(source, "utf8"), "pretend encyclopedia", "not movable: copied, the original stays");
    const [moved] = await library.importEntries([{ ...file, movable: true, move: true }]);
    const saved = path.join(library.archiveRoot, moved.item.path);
    assert.equal((await stat(saved)).ino, ino, "the same file, moved");
    assert.equal(moved.item.integrity, "pending", "moved at once, read after");
    await library.reading.verify();
    await library.reading.idle();
    assert.equal(library.catalog.get(moved.item.id).sha256, library.catalog.get(copied.item.id).sha256);
    assert.deepEqual(await readdir(path.dirname(source)), [], "it left its old folder");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("several big files chosen to be moved in all move, each into its own item folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-move-many-"));
  const library = await openLibrary(path.join(root, "archive"));
  try {
    await mkdir(path.join(root, "Drive"));
    const names = ["a.zim", "b.zim", "c.zim"];
    for (const name of names) await writeFile(path.join(root, "Drive", name), `edition ${name}`);
    const listed = await library.previewPaths(names.map((n) => path.join(root, "Drive", n)));
    const results = await library.importEntries(listed.map((f) => ({ ...f, movable: true, move: true })));
    assert.deepEqual(results.map((r) => r.error), [undefined, undefined, undefined]);
    assert.deepEqual(await readdir(path.join(root, "Drive")), [], "all of them moved");
    assert.equal(new Set(results.map((r) => path.dirname(r.item.path))).size, 3);
    assert.deepEqual(library.state().imports.map((t) => t.phase), ["complete", "complete", "complete"]);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});
