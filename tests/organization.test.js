import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
import { estimateMap } from "../desktop/renderer/map-estimate.js";
import { softwarePlan } from "../packages/sources/software.js";
test("folder imports are filed by type, keep where they came from, and reconcile moves, edits, missing and untracked files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-organize-"));
  let library;
  try {
    const source = path.join(root, "Bank", "2026");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "statement.txt"),
      "Original account statement.",
    );
    library = await openLibrary(path.join(root, "archive"));
    const [imported] = await library.importPaths([path.join(root, "Bank")]);
    await library.reading.idle();
    const result = { item: library.catalog.get(imported.item.id) };
    assert.ok(result.item.path.startsWith("Documents/statement--"));
    assert.equal(result.item.type, "document");
    assert.equal(result.item.kind, "note");
    assert.equal(result.item.source.folder, "Bank/2026");
    assert.equal(
      await readFile(path.join(source, "statement.txt"), "utf8"),
      "Original account statement.",
    );
    const old = path.join(library.archiveRoot, result.item.path),
      moved = path.join(path.dirname(path.dirname(old)), "Renamed statement");
    await rename(path.dirname(old), moved);
    const legacy=path.join(library.archiveRoot,"Legacy example");await mkdir(legacy);await writeFile(path.join(legacy,"item.json"),JSON.stringify({schemaVersion:1,id:"old-demo",title:"Old example",placeholder:true}));
    const movedReport = await library.check();
    assert.equal(movedReport.changes[0].status, "moved");
    const relinked = await library.resolveItem(result.item.id);
    assert.equal(relinked.filename, path.join(moved, "statement.txt"));
    await writeFile(relinked.filename, "User edited this document.");
    const modified = await library.check();
    assert.equal(modified.changes[0].status, "modified");
    assert.equal(
      library.catalog.get(result.item.id).sha256,
      result.item.sha256,
    );
    await library.accept(result.item.id);
    assert.notEqual(
      library.catalog.get(result.item.id).sha256,
      result.item.sha256,
    );
    assert.equal(
      library.catalog.get(result.item.id).previousVersions[0].sha256,
      result.item.sha256,
    );
    await writeFile(
      path.join(library.archiveRoot, "untracked.txt"),
      "User-added file",
    );
    await rm(relinked.filename);
    const missing = await library.check();
    assert.ok(missing.changes.some((c) => c.status === "missing"));
    assert.ok(missing.untracked.includes("untracked.txt"));
    assert.equal(library.catalog.list().length, 1);
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("archive check ignores links out of archive, and identical files can be kept twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-scan-"));
  let library;
  try {
    const source = path.join(root, "record.txt");
    await writeFile(source, "private");
    library = await openLibrary(path.join(root, "archive"));
    const publicCopy = await library.importPaths([source]);
    const again = await library.importPaths([source], { type: "other" });
    await library.reading.idle();
    assert.notEqual(publicCopy[0].item.id, again[0].item.id);
    assert.equal(library.catalog.get(publicCopy[0].item.id).sha256, library.catalog.get(again[0].item.id).sha256);
    if (process.platform !== "win32")
      await symlink(source, path.join(library.archiveRoot, "link.txt"));
    const report = await library.check();
    assert.equal(report.untracked.length, 0);
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("map estimate grows with area and detail; platform plans never guess incompatible packages", () => {
  const small = estimateMap([7.4, 43.7, 7.5, 43.8], 10),
    detailed = estimateMap([7.4, 43.7, 7.5, 43.8], 14),
    large = estimateMap([7, 43, 9, 45], 14);
  assert.ok(detailed.high > small.high);
  assert.ok(large.high > detailed.high);
  assert.equal(estimateMap([179, 0, -179, 1], 12), null);
  assert.equal(
    softwarePlan("kiwix", "darwin", "arm64").software.arch,
    "universal",
  );
  assert.throws(() => softwarePlan("kiwix", "linux", "arm64"), /No preset/);
  assert.throws(() => softwarePlan("lmstudio", "win32", "x64"), /No preset/);
});
