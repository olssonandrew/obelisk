import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, access, symlink, utimes } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
import { importFile } from "../packages/core/archive.js";

const exists = (file) => access(file).then(() => true, () => false);
const named = (library, name) => library.state().folders.find((f) => f.name === name);
const trashIn = (bin) => async (target) => {
  await mkdir(bin, { recursive: true });
  await rename(target, path.join(bin, `${path.basename(target)}-${Math.random()}`));
};
async function withLibrary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-safety-"));
  const library = await openLibrary(path.join(root, "lib"));
  try {
    await run(library, root);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function add(library, root, name, text = name, folderId) {
  const file = path.join(root, name);
  await writeFile(file, text);
  const [result] = await library.importEntries((await library.previewPaths([file])).map((f) => ({ ...f, folderId })));
  return result.item;
}

test("a file inside the library that changes while it is imported is kept", async () => {
  await withLibrary(async (library) => {
    const loose = path.join(library.archiveRoot, "Documents", "draft.txt");
    await writeFile(loose, "first");
    const put = library.catalog.put.bind(library.catalog);
    let saved = false;
    library.catalog.put = (item) => {
      // An editor saves between the copy and the clean-up.
      if (!saved) writeFileSync(loose, "second, longer");
      saved = true;
      return put(item);
    };
    const [entry] = await library.previewPaths([loose]);
    await library.importEntries([{ ...entry, inPlace: true }]);
    library.catalog.put = put;
    assert.equal(await readFile(loose, "utf8"), "second, longer");
  });
});

test("a recovery journal cannot move files outside the library", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-safety-"));
  try {
    const archive = path.join(root, "lib");
    await (await openLibrary(archive)).close();
    await writeFile(path.join(root, "outside.txt"), "mine");
    await writeFile(
      path.join(archive, ".obelisk", "journal.json"),
      JSON.stringify({ schemaVersion: 1, steps: [{ from: "../outside.txt", to: "Inbox/taken.txt" }] }),
    );
    await (await openLibrary(archive)).close();
    assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "mine");
    assert.ok(!(await exists(path.join(archive, "Inbox", "taken.txt"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moving a file that shares its folder moves only that file", async () => {
  await withLibrary(async (library, root) => {
    const item = await add(library, root, "notes.txt", "notes");
    const other = await add(library, root, "other.txt", "other");
    // Both files are dragged loose into Documents in Finder; a check follows them.
    for (const i of [item, other])
      await rename(path.join(library.archiveRoot, i.path), path.join(library.archiveRoot, "Documents", path.basename(i.path)));
    await library.check();
    const [moved] = await library.moveItems([item.id], named(library, "Inbox").id);
    assert.equal(moved, item.id);
    const now = library.catalog.get(item.id);
    assert.ok(now.path.startsWith("Inbox/"));
    assert.equal(await readFile(path.join(library.archiveRoot, now.path), "utf8"), "notes");
    assert.equal(now.manifestPath, undefined, "its manifest came along");
    assert.ok(await exists(path.join(library.archiveRoot, "Documents", path.basename(other.path))), "the rest stayed");
    await library.updateMetadata(item.id, { title: "Moved notes" });
  });
});

test("a move that fails partway is undone, leaving nothing half-moved", async () => {
  await withLibrary(async (library, root) => {
    const first = await add(library, root, "a.txt", "a");
    const second = await add(library, root, "b.txt", "b");
    const inbox = path.join(library.archiveRoot, "Inbox");
    const inboxBefore = (await readdir(inbox)).sort();
    // The second file was deleted in the file manager, so its rename fails after the first.
    await rm(path.join(library.archiveRoot, path.dirname(second.path)), { recursive: true });
    await assert.rejects(library.moveItems([first.id, second.id], named(library, "Inbox").id));
    // The first file was moved before the second failed; it's back where it was.
    const back = library.catalog.get(first.id);
    assert.ok(!back.path.startsWith("Inbox/"));
    assert.equal(await readFile(path.join(library.archiveRoot, back.path), "utf8"), "a");
    assert.deepEqual((await readdir(inbox)).sort(), inboxBefore, "no empty folders left behind");
    assert.ok(!(await exists(path.join(library.archiveRoot, ".obelisk", "journal.json"))));
  });
});

test("recovery that can't finish a rename keeps its plan and finishes on a later opening", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-safety-"));
  try {
    const archive = path.join(root, "lib");
    await (await openLibrary(archive)).close();
    await mkdir(path.join(archive, "Documents", "Thing"));
    await writeFile(path.join(archive, "Documents", "Thing", "note.txt"), "kept");
    // A file where the destination's folder should be: the rename can't happen.
    await writeFile(path.join(archive, "Locked"), "in the way");
    const journal = path.join(archive, ".obelisk", "journal.json");
    await writeFile(journal, JSON.stringify({ schemaVersion: 1, steps: [{ from: "Documents/Thing", to: "Locked/Thing" }] }));
    await (await openLibrary(archive)).close();
    assert.ok(await exists(journal), "the plan is kept when its rename fails");
    assert.ok(await exists(path.join(archive, "Documents", "Thing", "note.txt")));
    await rm(path.join(archive, "Locked"));
    await (await openLibrary(archive)).close();
    assert.ok(!(await exists(journal)));
    assert.equal(await readFile(path.join(archive, "Locked", "Thing", "note.txt"), "utf8"), "kept");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package changed while it's imported is kept; an unchanged one is tidied away", async () => {
  await withLibrary(async (library) => {
    const make = async (name) => {
      const pkg = path.join(library.archiveRoot, "Documents", name);
      await mkdir(path.join(pkg, "Data"), { recursive: true });
      await writeFile(path.join(pkg, "index.xml"), "<doc/>");
      await writeFile(path.join(pkg, "Data", "image.png"), "png");
      return pkg;
    };
    const changing = await make("Draft.pages"),
      still = await make("Final.pages");
    const put = library.catalog.put.bind(library.catalog);
    let saved = false;
    library.catalog.put = (item) => {
      // An app saves into the package between the copy and the clean-up.
      if (!saved && item.title?.startsWith("Draft")) writeFileSync(path.join(changing, "Data", "image.png"), "a newer, longer image");
      saved ||= item.title?.startsWith("Draft");
      return put(item);
    };
    const entries = await library.previewPaths([changing, still]);
    assert.ok(entries.every((e) => e.bundle), "both are read as packages");
    await library.importEntries(entries.map((e) => ({ ...e, inPlace: true })));
    library.catalog.put = put;
    assert.equal(await readFile(path.join(changing, "Data", "image.png"), "utf8"), "a newer, longer image");
    assert.ok(!(await exists(still)), "an unchanged package is removed once it's in the library");
  });
});

test("a checked item can be moved and then edited", async () => {
  await withLibrary(async (library, root) => {
    const item = await add(library, root, "song.mp3", "audio");
    await library.check();
    await library.moveItems([item.id], named(library, "Inbox").id);
    await library.updateMetadata(item.id, { title: "Renamed" });
    assert.equal(library.catalog.get(item.id).title, "Renamed");
  });
});

test("a removed item whose manifest was apart from its file stays removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-safety-"));
  try {
    const archive = path.join(root, "lib");
    let library = await openLibrary(archive);
    const item = await add(library, root, "paper.pdf", "%PDF-1.4");
    await rename(path.join(archive, item.path), path.join(archive, "Inbox", "paper.pdf"));
    await library.check();
    assert.ok(library.catalog.get(item.id).manifestPath);
    await library.removeItems([item.id], trashIn(path.join(root, "bin")));
    await library.close();
    // Windows may still hold a just-closed file for a moment (antivirus, indexing). Node
    // retries only with `recursive`, which also removes a single file.
    await rm(path.join(archive, ".obelisk", "catalog.sqlite"), { force: true, recursive: true, maxRetries: 10 });
    library = await openLibrary(archive);
    assert.ok(!library.catalog.get(item.id));
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder replaced by a link elsewhere is never written through", async () => {
  await withLibrary(async (library, root) => {
    const trip = await library.folders.create(named(library, "Documents").id, "Trip");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await rename(path.join(library.archiveRoot, trip.dir), path.join(root, "Trip, moved away"));
    // A junction on Windows, which needs no administrator; a symlink elsewhere.
    await symlink(outside, path.join(library.archiveRoot, trip.dir), "junction");
    const file = path.join(root, "note.txt");
    await writeFile(file, "hello");
    const [result] = await library.importEntries((await library.previewPaths([file])).map((f) => ({ ...f, folderId: trip.id })));
    assert.match(result.error, /outside the library/);
    const item = await add(library, root, "kept.txt");
    await assert.rejects(library.moveItems([item.id], trip.id), /outside the library/);
    await assert.rejects(library.folders.create(trip.id, "Deeper"), /outside the library/);
    await assert.rejects(library.folders.rename(trip.id, "Trip 2"));
    assert.deepEqual(await readdir(outside), []);
    assert.ok(await exists(path.join(library.archiveRoot, item.path)), "the moved file stays where it was");
  });
});

test("a package edited during its import is kept, even keeping its size beside a future timestamp", async () => {
  await withLibrary(async (library) => {
    const pkg = path.join(library.archiveRoot, "Documents", "Report.pages");
    await mkdir(pkg);
    await writeFile(path.join(pkg, "a.xml"), "aaaa");
    await writeFile(path.join(pkg, "b.xml"), "bbbb");
    const future = new Date(Date.now() + 86400000);
    await utimes(path.join(pkg, "a.xml"), future, future);
    const listed = await library.previewPaths([pkg]);
    assert.ok(listed[0].bundle, "a package is listed as one file");
    const put = library.catalog.put.bind(library.catalog);
    let edited = false;
    library.catalog.put = (item) => {
      // Saved by its app between the copy and the clean-up, the same length as before.
      if (!edited) writeFileSync(path.join(pkg, "b.xml"), "EDIT");
      edited = true;
      return put(item);
    };
    await library.importEntries(listed.map((e) => ({ ...e, inPlace: true })));
    library.catalog.put = put;
    assert.equal(await readFile(path.join(pkg, "b.xml"), "utf8"), "EDIT");
  });
});

test("an import whose manifest can't be written saves nothing and gives the file back", async () => {
  await withLibrary(async (library, root) => {
    const id = "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
      temporaryPath = path.join(root, "incoming.tmp");
    await writeFile(temporaryPath, "hello");
    // The short name is taken, so the item gets the long one, where item.json can't go:
    // writing it fails as a full disk would.
    await mkdir(path.join(library.archiveRoot, "Documents", `note--${id.slice(0, 8)}`));
    const blocked = path.join(library.archiveRoot, "Documents", `note--${id}`);
    await mkdir(path.join(blocked, "item.json"), { recursive: true });
    await writeFile(path.join(blocked, "item.json", "x"), "");
    await assert.rejects(
      importFile({ catalog: library.catalog, archiveRoot: library.archiveRoot, temporaryPath, filename: "note.txt", title: "note", id, directory: "Documents" }),
    );
    assert.equal(await readFile(temporaryPath, "utf8"), "hello");
    assert.deepEqual((await readdir(blocked)).sort(), ["item.json"], "no file or half-written manifest left behind");
    assert.equal(library.catalog.get(id), null);
  });
});

test("a recovery step whose destination is taken stays unfinished, and the index stays with the files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-safety-"));
  try {
    const archive = path.join(root, "lib");
    let library = await openLibrary(archive);
    const a = await library.folders.create(named(library, "Documents").id, "A");
    const item = await add(library, root, "note.txt", "hello", a.id);
    await library.close();
    const journal = path.join(archive, ".obelisk", "journal.json");
    await mkdir(path.join(archive, "Documents", "B"));
    await writeFile(journal, JSON.stringify({ schemaVersion: 1, steps: [{ from: "Documents/A", to: "Documents/B" }] }));
    library = await openLibrary(archive);
    assert.equal(library.catalog.get(item.id).path, item.path);
    assert.ok(await exists(path.join(archive, item.path)));
    assert.ok(await exists(journal), "the unfinished move stays written down");
    // Other moves wait for it, rather than writing over its plan.
    const other = await library.folders.create(named(library, "Documents").id, "Other");
    await assert.rejects(library.folders.rename(other.id, "Renamed"), /“Documents\/B” is in the way/);
    assert.ok(await exists(journal), "still written down after another move was tried");
    await library.close();
    // Once the destination is free, the move is finished on the next opening.
    await rm(path.join(archive, "Documents", "B"), { recursive: true });
    library = await openLibrary(archive);
    const moved = library.catalog.get(item.id).path;
    assert.ok(moved.startsWith("Documents/B/"), moved);
    assert.ok(await exists(path.join(archive, moved)));
    assert.ok(!(await exists(journal)));
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
