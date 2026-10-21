import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileDate, sourceDate, readDate } from "../packages/core/dates.js";
import { zipPackage } from "../packages/core/bundle.js";
import { openLibrary } from "../packages/core/library.js";

/** A JPEG holding only an EXIF block with DateTimeOriginal. */
function jpegTaken(when) {
  const tiff = Buffer.alloc(64);
  tiff.write("II", 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry pointing to the EXIF IFD
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26); // EXIF IFD: DateTimeOriginal, ASCII, 20 bytes at 44
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36);
  tiff.write(`${when}\0`, 44, "latin1");
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]),
    head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(app1.length + 2, 4);
  return Buffer.concat([head, app1, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

test("dates are read from inside photos, PDFs, MP3s and EPUBs, and from where downloads came from", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "obelisk-dates-"));
  try {
    await writeFile(path.join(dir, "photo.jpg"), jpegTaken("2009:04:10 07:00:00"));
    await writeFile(path.join(dir, "paper.pdf"), "%PDF-1.4\n1 0 obj << /CreationDate (D:20030512120000Z) >> endobj\n%%EOF");
    const frame = Buffer.concat([Buffer.from("TYER", "latin1"), Buffer.from([0, 0, 0, 5, 0, 0, 0]), Buffer.from("1999", "latin1")]),
      id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frame.length]), frame]);
    await writeFile(path.join(dir, "song.mp3"), id3);
    const book = path.join(dir, "book");
    await mkdir(path.join(book, "META-INF"), { recursive: true });
    await writeFile(path.join(book, "mimetype"), "application/epub+zip");
    await writeFile(path.join(book, "META-INF", "container.xml"), '<rootfile full-path="content.opf"/>');
    await writeFile(path.join(book, "content.opf"), '<dc:date opf:event="modification">2020-01-01</dc:date><dc:date opf:event="publication">1854-08-09</dc:date>');
    await zipPackage(book, path.join(dir, "book.epub"), "epub");
    assert.equal(await fileDate(path.join(dir, "photo.jpg")), "2009-04-10");
    assert.equal(await fileDate(path.join(dir, "paper.pdf")), "2003-05-12");
    assert.equal(await fileDate(path.join(dir, "song.mp3")), "1999");
    assert.equal(await fileDate(path.join(dir, "book.epub")), "1854-08-09", "the publication date, not the edit date");
    assert.equal(await fileDate(path.join(dir, "missing.jpg")), null);
    assert.equal(readDate("0000:00:00 00:00:00"), null, "blank camera dates are ignored");
    assert.equal(sourceDate({ adapter: "web", snapshot: "20080315120000", capturedAt: "2026-10-14T00:00:00Z" }), "2008-03-15");
    assert.equal(sourceDate({ adapter: "maps", version: "2026-10-12" }), "2026-10-12");
    assert.equal(sourceDate({ adapter: "video", uploaded: "20210911" }), "2021-09-11");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("imports get the date inside the file, and files added earlier get theirs once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-dated-"));
  try {
    await writeFile(path.join(root, "photo.jpg"), jpegTaken("2012:06:01 09:30:00"));
    let library = await openLibrary(path.join(root, "archive"));
    const [imported] = await library.importPaths([path.join(root, "photo.jpg")]);
    assert.equal(imported.item.created, "2012-06-01");
    // An older file with no date, and one whose date someone typed.
    const older = path.join(library.archiveRoot, "Documents", "old--a1");
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, "old.pdf"), "%PDF-1.4 << /CreationDate (D:19970101) >>");
    await writeFile(path.join(older, "item.json"), JSON.stringify({ schemaVersion: 1, id: "a1", title: "old", type: "document", filename: "old.pdf", path: "Documents/old--a1/old.pdf", bytes: 1, sha256: "0".repeat(64), acquiredAt: new Date().toISOString() }));
    await library.close();
    // As if the archive predates reading dates: the one-time pass has not run.
    await rm(path.join(root, "archive", ".obelisk", "dates-filled"), { force: true });
    library = await openLibrary(path.join(root, "archive"));
    await library.settled();
    assert.equal(library.catalog.get("a1").created, "1997-01-01");
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
