import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, utimes, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";

async function withLibrary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-checking-"));
  let library = await openLibrary(path.join(root, "archive"));
  try {
    await run({
      root,
      library: () => library,
      reopen: async () => {
        await library.close();
        library = await openLibrary(path.join(root, "archive"));
        return library;
      },
    });
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function add(library, root, name, body) {
  await writeFile(path.join(root, name), body);
  const [result] = await library.importPaths([path.join(root, name)]);
  await library.reading.idle();
  const item = library.catalog.get(result.item.id);
  return { item, file: path.join(library.archiveRoot, item.path) };
}
/** Writes new contents of the same size, then puts the date back, as silent damage would. */
async function damage(file, body) {
  const { atime, mtime } = await stat(file);
  await writeFile(file, body);
  await utimes(file, atime, mtime);
}

test("a check trusts an unchanged size and date; Verify contents reads, and finds damage", async () => {
  await withLibrary(async ({ root, library }) => {
    const { item, file } = await add(library(), root, "letter.txt", "Dear reader, hello.");
    assert.ok(item.stamp && item.verifiedAt, "its size and date are recorded with its checksum");
    await damage(file, "Dear reader, HELLO.");
    const quick = await library().check();
    assert.deepEqual(quick.changes, [], "the check doesn't read a file whose size and date are the same");
    await library().reading.verify();
    assert.ok(library().state().reading.run, "a run is under way");
    await library().reading.idle();
    const checked = library().catalog.get(item.id);
    assert.equal(checked.fileState, "damaged");
    assert.equal(checked.sha256, item.sha256, "the recorded checksum is kept");
    assert.equal(library().state().reading.run, null, "the run is over once every file is read");
    assert.equal(library().state().reading.damaged, 1);
    // Still damaged at the next check, until it's read again and matches.
    assert.equal((await library().check()).changes[0].status, "damaged");
  });
});

test("a check started during a change waits for it, rather than refusing", async () => {
  await withLibrary(async ({ root, library }) => {
    const { item } = await add(library(), root, "note.txt", "A short note.");
    const tagging = library().updateTags([item.id], ["kept"], "add");
    const checked = await library().check();
    await tagging;
    assert.deepEqual(checked.changes, []);
    assert.deepEqual(library().catalog.get(item.id).tags, ["kept"]);
  });
});

test("a check catches a change of size or date, reading only what it must", async () => {
  await withLibrary(async ({ root, library }) => {
    const { item, file } = await add(library(), root, "notes.txt", "first draft");
    await writeFile(file, "a longer second draft");
    assert.equal((await library().check()).changes[0].status, "modified");
    await library().accept(item.id);
    // Saved again with the same size: the date changed, so it is read.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, "a longer second DRAFT");
    const report = await library().check();
    assert.equal(report.changes[0].status, "modified");
    assert.equal(library().catalog.get(item.id).observedSha256, createHash("sha256").update("a longer second DRAFT").digest("hex"));
  });
});

test("files from before sizes and dates were kept get them at the next check, and are verified first", async () => {
  await withLibrary(async ({ root, library, reopen }) => {
    const { item, file } = await add(library(), root, "old.txt", "kept a long time");
    const newer = await add(library(), root, "new.txt", "added later");
    const manifest = path.join(path.dirname(file), "item.json"),
      saved = JSON.parse(await readFile(manifest, "utf8"));
    delete saved.stamp;
    delete saved.verifiedAt;
    await writeFile(manifest, JSON.stringify(saved));
    await (await reopen()).settled();
    await library().check();
    const checked = library().catalog.get(item.id);
    assert.ok(checked.stamp, "it gets a size and date");
    assert.equal(checked.verifiedAt, undefined, "without claiming it was read");
    await library().reading.verify();
    await library().reading.idle();
    const read = library().catalog.get(item.id);
    assert.ok(read.verifiedAt <= library().catalog.get(newer.item.id).verifiedAt, "the never-verified file came first");
    assert.equal(read.fileState, "ok");
  });
});

test("a ZIM is checked against the checksum it carries", async () => {
  await withLibrary(async ({ root, library }) => {
    // The smallest ZIM-shaped file: a header saying where its MD5 is, then the MD5.
    const zim = (corrupt) => {
      const body = Buffer.alloc(200, 1);
      body.writeUInt32LE(72173914, 0);
      body.writeBigUInt64LE(184n, 72);
      createHash("md5").update(body.subarray(0, 184)).digest().copy(body, 184);
      if (corrupt) body[100] = 9;
      return body;
    };
    const good = await add(library(), root, "good.zim", zim(false));
    assert.equal(good.item.integrity, "publisher-verified");
    assert.equal(good.item.fileState ?? "ok", "ok");
    const bad = await add(library(), root, "bad.zim", zim(true));
    assert.equal(bad.item.fileState, "damaged", "a ZIM that fails its own checksum arrived damaged");
  });
});

test("a Verify contents run carries on after the library is closed and opened again", async () => {
  await withLibrary(async ({ root, library, reopen }) => {
    await add(library(), root, "a.txt", "one");
    await add(library(), root, "b.txt", "two");
    library().reading.pause();
    await library().reading.verify();
    library().reading.pause();
    await access(path.join(library().archiveRoot, ".obelisk", "verify.json"));
    const again = await reopen();
    assert.ok(again.state().reading.run, "the run is remembered");
    await again.reading.idle();
    assert.equal(again.state().reading.run, null);
    assert.equal(again.state().reading.verified, 2);
    await assert.rejects(access(path.join(again.archiveRoot, ".obelisk", "verify.json")));
  });
});
