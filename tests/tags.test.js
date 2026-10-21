import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
import { normalizeTags } from "../packages/core/tags.js";

test("tags normalize, support concurrent bulk edits, and survive catalog rebuilding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-tags-")); let library;
  try {
    assert.deepEqual(normalizeTags([" History ","HISTORY","read   later",""]), ["history","read later"]);
    assert.throws(() => normalizeTags(["x".repeat(51)]));
    await writeFile(path.join(root,"one.txt"),"one"); await writeFile(path.join(root,"two.txt"),"two");
    library = await openLibrary(path.join(root,"archive"));
    const imported = await library.importPaths([path.join(root,"one.txt"),path.join(root,"two.txt")]);
    const ids = imported.map(r => r.item.id);
    await Promise.all([library.updateTags(ids,["History"],"add"),library.updateTags(ids,["Favorites"],"add")]);
    assert.deepEqual(library.catalog.get(ids[0]).tags,["favorites","history"]);
    await library.updateTags([ids[0]],["history"],"remove");
    await library.updateTags([ids[1]],["read later"],"replace");
    await library.close(); library = null;
    await rm(path.join(root,"archive/.obelisk"),{recursive:true,force:true});
    library = await openLibrary(path.join(root,"archive"));
    assert.deepEqual(library.catalog.get(ids[0]).tags,["favorites"]);
    assert.deepEqual(library.catalog.get(ids[1]).tags,["read later"]);
    await assert.rejects(library.updateTags([...ids,"invalid"],["bad"],"add"));
    assert.deepEqual(library.catalog.get(ids[0]).tags,["favorites"]);
    assert.equal(await readFile(path.join(root,"one.txt"),"utf8"),"one");
  } finally {await library?.close();await rm(root,{recursive:true,force:true});}
});

test("tags refuse manifests linked outside the archive", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-tags-boundary-")); let library;
  try {
    await writeFile(path.join(root,"one.txt"),"one"); library = await openLibrary(path.join(root,"archive"));
    const [{item}] = await library.importPaths([path.join(root,"one.txt")]);
    const manifest = path.join(root,"archive",path.dirname(item.path),"item.json");
    await writeFile(path.join(root,"outside.json"),"unchanged"); await rm(manifest); await symlink(path.join(root,"outside.json"),manifest);
    await assert.rejects(library.updateTags([item.id],["test"],"add"),/outside/);
    assert.equal(await readFile(path.join(root,"outside.json"),"utf8"),"unchanged");
  } finally {await library?.close();await rm(root,{recursive:true,force:true});}
});
