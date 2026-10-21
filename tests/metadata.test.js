import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
test("metadata edits preserve files, source history, concurrent tags, and rebuild correctly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-metadata-"));
  let library;
  try {
    const file = path.join(root, "original.txt");
    await writeFile(file, "Original bytes");
    library = await openLibrary(path.join(root, "archive"));
    const [{ item }] = await library.importPaths([file]);
    await Promise.all([
      library.updateMetadata(item.id, {
        title: "A useful name",
        description: "Why I saved this.",
        favorite: true,
      }),
      library.updateTags([item.id], ["reference"], "add"),
    ]);
    const updated = library.catalog.get(item.id);
    assert.equal(updated.title, "A useful name");
    assert.deepEqual(updated.tags, ["reference"]);
    assert.equal(updated.path, item.path);
    assert.equal(updated.sha256, item.sha256);
    assert.deepEqual(updated.source, item.source);
    assert.equal(updated.originalMetadata.title, "original", "imported titles drop the extension");
    assert.equal(
      await readFile(path.join(root, "archive", item.path), "utf8"),
      "Original bytes",
    );
    await library.updateMetadata(item.id, { title: "Another name" });
    assert.equal(
      library.catalog.get(item.id).originalMetadata.title,
      "original",
    );
    await assert.rejects(library.updateMetadata(item.id, { title: "  " }));
    await assert.rejects(
      library.updateMetadata(item.id, { path: "../escape" }),
    );
    await assert.rejects(library.updateMetadata(item.id, { favorite: "yes" }));
    await library.close();
    library = null;
    await rm(path.join(root, "archive/.obelisk"), {
      recursive: true,
      force: true,
    });
    library = await openLibrary(path.join(root, "archive"));
    assert.equal(library.catalog.get(item.id).title, "Another name");
    assert.equal(library.catalog.get(item.id).description, "Why I saved this.");
    assert.equal(library.catalog.get(item.id).favorite, true);
    assert.deepEqual(library.catalog.get(item.id).tags, ["reference"]);
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("archival fields, ratings, tag renames, and removal stay inside the archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-fields-"));
  let library;
  try {
    const files = ["one.txt", "two.txt"].map((n) => path.join(root, n));
    await writeFile(files[0], "One");
    await writeFile(files[1], "Two");
    library = await openLibrary(path.join(root, "archive"));
    const [a, b] = (await library.importPaths(files)).map((r) => r.item);
    const edited = await library.updateMetadata(a.id, {
      creator: "  Ada   Lovelace ",
      created: "c. 1843",
      rights: "Public domain",
      rating: 4,
    });
    assert.equal(edited.creator, "Ada Lovelace");
    assert.equal(edited.rating, 4);
    assert.equal(edited.originalMetadata.rights, a.rights);
    assert.equal(edited.originalMetadata.title, undefined);
    await assert.rejects(library.updateMetadata(a.id, { rating: 6 }));
    await assert.rejects(library.updateMetadata([a.id, b.id], { title: "Same" }));
    const both = await library.updateMetadata([a.id, b.id], { rating: 2 });
    assert.deepEqual(both.map((i) => i.rating), [2, 2]);
    await library.updateTags([a.id, b.id], ["histroy", "keep"], "add");
    assert.equal(await library.renameTag("histroy", "history"), 2);
    assert.deepEqual(library.catalog.get(b.id).tags, ["history", "keep"]);
    assert.equal(await library.renameTag("keep"), 2);
    assert.deepEqual(library.catalog.get(a.id).tags, ["history"]);
    const trashed = [];
    await assert.rejects(library.removeItems([a.id]));
    assert.deepEqual(
      await library.removeItems([a.id], async (target) => {
        trashed.push(target);
        await rm(target, { recursive: true });
      }),
      [a.id],
    );
    assert.equal(trashed.length, 1);
    assert.ok(trashed[0].endsWith(path.dirname(a.path)));
    assert.equal(library.catalog.get(a.id), null);
    assert.equal(
      await readFile(path.join(root, "archive", b.path), "utf8"),
      "Two",
    );
    await library.close();
    library = await openLibrary(path.join(root, "archive"));
    assert.deepEqual(
      library.state().items.map((i) => i.id),
      [b.id],
    );
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("files are filed by format, can be moved to another folder, and kinds stay within their shelf", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-shelves-"));
  let library;
  try {
    const song = path.join(root, "song.mp3"),
      notes = path.join(root, "notes.md"),
      table = path.join(root, "table.csv"),
      setup = path.join(root, "tool.zip");
    for (const file of [song, notes, table, setup]) await writeFile(file, file);
    library = await openLibrary(path.join(root, "archive"));
    const [audio] = await library.importPaths([song], {
      type: "audio",
      kind: "music",
    });
    assert.equal(audio.item.kind, "music");
    assert.ok(audio.item.path.startsWith("Audio/"), "audio goes to the Audio folder");
    await assert.rejects(
      library.importPaths([notes], { type: "audio", kind: "book" }),
    );
    await library.importPaths([notes, table]);
    // Naming a shelf files anything there, whatever its extension suggests.
    const [tool] = await library.importPaths([setup], { type: "software" });
    assert.equal(tool.item.type, "software");
    assert.equal(tool.item.software.platform, "unknown");
    const shown = Object.fromEntries(
      library.state().items.map((i) => [i.filename, [i.type, i.kind, i.media]]),
    );
    assert.deepEqual(shown, {
      "song.mp3": ["audio", "music", "audio"],
      "notes.md": ["document", "note", "text"],
      "table.csv": ["other", "data", "text"],
      "tool.zip": ["software", undefined, ""],
    });
    const note = library.state().items.find((i) => i.filename === "notes.md");
    assert.equal(
      (await library.updateMetadata(note.id, { kind: "manual" })).kind,
      "manual",
    );
    await assert.rejects(library.updateMetadata(note.id, { kind: "music" }));
    // Moving files is by folder; how a file opens never changes with it.
    const reference = library.state().folders.find((f) => f.name === "Reference" && !f.parent);
    assert.deepEqual(await library.moveItems([note.id], reference.id), [note.id]);
    const moved = library.catalog.get(note.id);
    assert.ok(moved.path.startsWith("Reference/"));
    assert.equal(await library.readText(note.id), notes);
    assert.equal(moved.sha256, note.sha256);
    await assert.rejects(library.moveItems([note.id], "nowhere"));
    await library.close();
    library = await openLibrary(path.join(root, "archive"));
    const reopened = library.state().items.find((i) => i.id === note.id);
    assert.equal(reopened.folderId, reference.id);
    assert.equal(reopened.media, "text");
    assert.equal((await library.check()).changes.length, 0);
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
