import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, rename } from "node:fs/promises";
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
