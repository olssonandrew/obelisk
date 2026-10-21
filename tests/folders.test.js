import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, access, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
import { safeName } from "../packages/core/folders.js";

const named = (library, name, parent) =>
  library.state().folders.find((f) => f.name === name && (parent === undefined || f.parent === parent));
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = (file) => access(file).then(() => true, () => false);
// Stands in for the system Trash: moves things somewhere outside the library.
const trashIn = (bin) => async (target) => {
  await mkdir(bin, { recursive: true });
  await rename(target, path.join(bin, `${path.basename(target)}-${Date.now()}`));
};

test("a new library starts with default folders, each a real directory with folder.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  const library = await openLibrary(path.join(root, "lib"));
  try {
    const state = library.state(),
      top = state.folders.filter((f) => !f.parent).map((f) => f.name);
    assert.deepEqual(top.sort(), ["Audio", "Backups", "Documents", "Images", "Inbox", "Maps", "Other", "Reference", "Software", "Video"]);
    const music = named(library, "Music", named(library, "Audio").id);
    assert.equal(music.dir, "Audio/Music");
    assert.equal((await json(path.join(library.archiveRoot, "Audio", "Music", "folder.json"))).id, music.id);
    assert.equal(state.inbox, named(library, "Inbox").id);
    assert.equal(state.destinations.podcasts, named(library, "Podcasts").id);
    assert.equal(state.destinations.web, named(library, "Websites").id);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("folders can be made, renamed (directory follows), re-iconed and moved at any depth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  const library = await openLibrary(path.join(root, "lib"));
  try {
    const music = named(library, "Music");
    const album = await library.folders.create(music.id, "Kind of Blue", "album");
    const deep = await library.folders.create(album.id, "Bonus: takes / outtakes");
    assert.equal(deep.dir, "Audio/Music/Kind of Blue/Bonus- takes - outtakes", "unsafe characters are replaced on disk");
    assert.equal(deep.name, "Bonus: takes / outtakes", "the display name keeps them");
    const song = path.join(root, "So What.mp3");
    await writeFile(song, "audio");
    const [imported] = await library.importEntries((await library.previewPaths([song])).map((f) => ({ ...f, folderId: album.id })));
    assert.ok(imported.item.path.startsWith("Audio/Music/Kind of Blue/So What--"));
    // Renaming changes the directory and every path inside it.
    await library.folders.rename(album.id, "Kind of Blue (1959)");
    const item = library.catalog.get(imported.item.id);
    assert.ok(item.path.startsWith("Audio/Music/Kind of Blue (1959)/"));
    assert.equal(await readFile(path.join(library.archiveRoot, item.path), "utf8"), "audio");
    assert.equal(library.state().items[0].folderId, album.id);
    // A case-only rename works on case-insensitive disks.
    await library.folders.rename(album.id, "KIND OF BLUE (1959)");
    assert.ok((await readdir(path.join(library.archiveRoot, "Audio", "Music"))).includes("KIND OF BLUE (1959)"));
    await library.folders.setIcon(album.id, "star");
    assert.equal((await json(path.join(library.archiveRoot, "Audio", "Music", "KIND OF BLUE (1959)", "folder.json"))).icon, "star");
    // Moving into another folder; never into itself.
    const jazz = await library.folders.create(null, "Jazz");
    await library.folders.move(album.id, jazz.id);
    assert.ok(library.catalog.get(imported.item.id).path.startsWith("Jazz/KIND OF BLUE (1959)/"));
    await assert.rejects(library.folders.move(jazz.id, deep.id), /inside itself/);
    // A sibling with the same name (ignoring case) gets a number.
    const twin = await library.folders.create(jazz.id, "kind of blue (1959)");
    assert.equal(path.posix.basename(twin.dir), "kind of blue (1959) 2");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a folder moves its contents up, or sends everything to the Trash; never silently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  const library = await openLibrary(path.join(root, "lib"));
  const trash = trashIn(path.join(root, "Trash"));
  try {
    const docs = named(library, "Documents"),
      project = await library.folders.create(docs.id, "Project"),
      inner = await library.folders.create(project.id, "Drafts");
    const file = path.join(root, "plan.txt");
    await writeFile(file, "plan");
    const [kept] = await library.importEntries((await library.previewPaths([file])).map((f) => ({ ...f, folderId: project.id })));
    await assert.rejects(library.folders.remove(named(library, "Inbox").id, { keep: true, trash }), /Inbox/);
    await library.folders.remove(project.id, { keep: true, trash });
    assert.ok(library.catalog.get(kept.item.id).path.startsWith("Documents/plan--"), "the file moved up");
    assert.equal(named(library, "Drafts").parent, docs.id, "so did the subfolder");
    assert.equal(await readFile(path.join(library.archiveRoot, library.catalog.get(kept.item.id).path), "utf8"), "plan");
    // With contents: the folder and its files leave the library, to the Trash.
    await library.folders.remove(inner.id, { keep: false, trash });
    await library.folders.remove(docs.id, { keep: false, trash });
    assert.equal(library.catalog.get(kept.item.id), null);
    // The emptied Project folder, then Drafts, then Documents with its contents.
    assert.equal((await readdir(path.join(root, "Trash"))).length, 3);
    assert.equal(named(library, "Documents"), undefined);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("importers keep their folder through renames and moves; a deleted one is not guessed or recreated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  let library = await openLibrary(path.join(root, "lib"));
  try {
    const maps = named(library, "Maps"),
      trips = await library.folders.create(null, "Trips");
    await library.folders.rename(maps.id, "Travel maps");
    await library.folders.move(maps.id, trips.id);
    assert.equal(library.state().destinations.maps, maps.id);
    await library.folders.remove(maps.id, { keep: false, trash: trashIn(path.join(root, "Trash")) });
    assert.equal(library.state().destinations.maps, undefined, "no destination after deletion");
    assert.throws(
      () => library.downloads.addPlan({ url: "https://example.com/a.pmtiles", filename: "a.pmtiles", source: { adapter: "maps" } }),
      /Choose a folder/,
    );
    // Reopening keeps folders, icons and destinations, and the deleted default stays gone.
    await library.folders.setIcon(trips.id, "flag");
    await library.close();
    library = await openLibrary(path.join(root, "lib"));
    assert.equal(named(library, "Trips").icon, "flag");
    assert.equal(named(library, "Travel maps"), undefined);
    assert.equal(named(library, "Maps"), undefined);
    assert.equal(library.state().destinations.web, named(library, "Websites").id);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a podcast show folder keeps receiving episodes wherever it is moved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  // A transfer that "downloads" by copying the file next to the library.
  const local = async ({ job, temporaryPath }) => cp(path.join(root, job.filename), temporaryPath);
  const library = await openLibrary(path.join(root, "lib"), undefined, { drivers: { local } });
  try {
    const episode = (n) => ({ source: { adapter: "podcasts" }, collection: { id: "feed-7", title: "The Show" }, folderId: library.folders.list().find((f) => f.name === "Podcasts").id, n });
    const first = await placeOf(library, episode(1));
    assert.equal(first, "Audio/Podcasts/The Show");
    const show = named(library, "The Show"),
      elsewhere = await library.folders.create(null, "Listening");
    await library.folders.rename(show.id, "Favourite show");
    await library.folders.move(show.id, elsewhere.id);
    assert.equal(await placeOf(library, episode(2)), "Listening/Favourite show");
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});
/** Runs a fake podcast download through the real pipeline and says which folder it landed in. */
async function placeOf(library, plan) {
  const file = path.join(library.archiveRoot, "..", `episode-${plan.n}.mp3`);
  await writeFile(file, `episode ${plan.n}`);
  const job = library.downloads.addPlan({
    ...plan,
    url: `https://example.com/episode-${plan.n}.mp3`,
    filename: `episode-${plan.n}.mp3`,
    title: `Episode ${plan.n}`,
    driver: "local",
  });
  for (let i = 0; i < 100; i++) {
    const done = library.catalog.job(job.id);
    if (done?.status === "complete") return path.posix.dirname(path.posix.dirname(library.catalog.get(done.itemId).path));
    if (done?.status === "failed") throw new Error(done.error);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Download did not finish");
}

test("an existing library is adopted without moving anything; Finder copies and crashes are handled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-folders-"));
  const archive = path.join(root, "old");
  try {
    // A library from before folders: shelf directories and a podcast show directory.
    const item = (dir, id, filename, extra = {}) => ({ schemaVersion: 1, id, title: id, filename, path: `${dir}/${filename}`, bytes: 1, sha256: "0".repeat(64), acquiredAt: new Date().toISOString(), ...extra });
    for (const [dir, id, filename, extra] of [
      ["Documents/a--1", "a1", "a.txt"],
      ["Audio/Show--99/ep--2", "e2", "ep.mp3", { collection: { id: "99", title: "Show" } }],
    ]) {
      await mkdir(path.join(archive, dir), { recursive: true });
      await writeFile(path.join(archive, dir, filename), "x");
      await writeFile(path.join(archive, dir, "item.json"), JSON.stringify(item(dir, id, filename, extra)));
    }
    let library = await openLibrary(archive);
    assert.deepEqual((await readdir(path.join(archive, "Documents"))).sort(), ["a--1", "folder.json"], "nothing moved");
    const show = named(library, "Show");
    assert.equal(show.dir, "Audio/Show--99");
    assert.equal(library.state().items.find((i) => i.id === "e2").folderId, show.id);
    assert.equal(library.state().destinations["files:document"], named(library, "Documents").id);
    assert.ok(named(library, "Inbox"), "Inbox is added");
    assert.equal(library.state().untracked, 0, "folder.json files are not reported as stray files");
    // A folder copied in Finder carries the same ID; the copy gets its own.
    await cp(path.join(archive, "Documents"), path.join(archive, "Documents copy"), { recursive: true });
    await library.folders.rescan();
    const ids = library.state().folders.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
    // (Its copied items repeat item IDs too; the file check reports those separately.)
    await rm(path.join(archive, "Documents copy"), { recursive: true });
    await library.folders.rescan();
    // A move interrupted by a crash is finished on the next open.
    await library.close();
    await writeFile(path.join(archive, ".obelisk", "journal.json"), JSON.stringify({ steps: [{ from: "Documents/a--1", to: "Audio/a--1" }] }));
    library = await openLibrary(archive);
    await library.settled();
    assert.ok(await exists(path.join(archive, "Audio", "a--1", "a.txt")));
    assert.ok(!(await exists(path.join(archive, ".obelisk", "journal.json"))));
    assert.equal(library.catalog.get("a1").path, "Audio/a--1/a.txt");
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory names stay safe on every platform", () => {
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(safeName("  ..hidden.. "), "hidden");
  assert.equal(safeName("CON"), "CON-");
  assert.equal(safeName(""), "Folder");
  assert.equal(safeName("x".repeat(200)).length, 80);
});

test("a library made before the rename opens with its state and folders intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-legacy-"));
  try {
    const archive = path.join(root, "archive");
    let library = await openLibrary(archive);
    await library.folders.create(null, "Kept");
    await library.close();
    await rename(path.join(archive, ".obelisk"), path.join(archive, ".alexandria"));
    const guide = path.join(archive, "ABOUT THIS ARCHIVE.txt");
    await writeFile(guide, (await readFile(guide, "utf8")).replaceAll("Obelisk", "Alexandria").replace(".obelisk/", ".alexandria/"));
    library = await openLibrary(archive);
    assert.ok(named(library, "Kept"));
    assert.ok(!(await exists(path.join(archive, ".alexandria"))));
    assert.ok(!/alexandria/i.test(await readFile(guide, "utf8")));
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files that have been checked keep working after their folder moves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-checked-"));
  try {
    const archive = path.join(root, "lib");
    let library = await openLibrary(archive);
    const album = await library.folders.create(named(library, "Music").id, "Album");
    const song = path.join(root, "song.mp3");
    await writeFile(song, "audio");
    const [imported] = await library.importEntries((await library.previewPaths([song])).map((f) => ({ ...f, folderId: album.id })));
    // A check records where each manifest is.
    const manifest = path.join(archive, path.dirname(imported.item.path), "item.json");
    const recorded = { ...(await json(manifest)), manifestPath: path.relative(archive, manifest) };
    await writeFile(manifest, JSON.stringify(recorded));
    library.catalog.put({ ...library.catalog.get(imported.item.id), manifestPath: recorded.manifestPath });
    await library.folders.rename(album.id, "Album (renamed)");
    await library.updateMetadata(imported.item.id, { title: "Renamed song" });
    await library.close();
    // A rebuilt catalog finds the file where it is now.
    await rm(path.join(archive, ".obelisk", "catalog.sqlite"), { force: true });
    library = await openLibrary(archive);
    const item = library.catalog.get(imported.item.id);
    assert.ok(item.path.startsWith("Audio/Music/Album (renamed)/"));
    assert.equal(item.title, "Renamed song");
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folders keep the order they were dragged into, until they move elsewhere", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-order-"));
  try {
    const archive = path.join(root, "lib");
    let library = await openLibrary(archive);
    const music = named(library, "Music");
    const made = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) made.push(await library.folders.create(music.id, name));
    await library.folders.order(music.id, [made[2].id, made[0].id, made[1].id]);
    await library.close();
    library = await openLibrary(archive);
    const positions = Object.fromEntries(library.state().folders.filter((f) => f.parent === music.id).map((f) => [f.name, f.position]));
    assert.deepEqual(positions, { Gamma: 0, Alpha: 1, Beta: 2 });
    await library.folders.move(made[2].id, null);
    assert.equal(library.state().folders.find((f) => f.id === made[2].id).position, undefined);
    await library.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
