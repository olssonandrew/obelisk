import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLibrary } from "../packages/core/library.js";
import { inside, fileResponse } from "../desktop/files.js";
import { cloudService } from "../desktop/cloud-folders.js";

test("desktop library imports originals, previews text, rebuilds, and isolates archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-desktop-"));
  let a, b;
  try {
    const source = path.join(root, "sample.txt");
    await writeFile(source, "My original document.");
    a = await openLibrary(path.join(root, "first"));
    const [result] = await a.importPaths([source]);
    assert.ok(result.item);
    assert.equal(await a.readText(result.item.id), "My original document.");
    // Importing the same file again makes a second copy rather than refusing it.
    assert.ok((await a.importPaths([source]))[0].item);
    assert.equal(a.state().items.length, 2);
    b = await openLibrary(path.join(root, "second"));
    assert.equal(b.state().items.length, 0);
    await assert.rejects(b.resolveItem(result.item.id), /no saved file/);
    a.catalog.put({
      schemaVersion: 1,
      id: "escape",
      title: "Escape",
      path: "../sample.txt",
    });
    await assert.rejects(a.resolveItem("escape"), /outside/);
    await a.close();
    a = await openLibrary(path.join(root, "first"));
    assert.equal(await a.readText(result.item.id), "My original document.");
  } finally {
    await a?.close();
    await b?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop file protocol bounds paths and serves seekable media ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-protocol-"));
  try {
    const archive = path.join(root, "archive");
    await mkdir(archive);
    const file = path.join(archive, "sample.mp3");
    await writeFile(file, "0123456789");
    await writeFile(path.join(root, "private.txt"), "private");
    assert.equal(await inside(archive, "sample.mp3"), await realpath(file));
    await assert.rejects(inside(archive, "../private.txt"), /outside/);
    if (process.platform !== "win32") {
      await symlink(
        path.join(root, "private.txt"),
        path.join(archive, "escape"),
      );
      await assert.rejects(inside(archive, "escape"), /outside/);
    }
    const response = await fileResponse(
      new Request("https://local/file", { headers: { Range: "bytes=2-5" } }),
      file,
    );
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "2345");
    assert.equal(response.headers.get("Content-Range"), "bytes 2-5/10");
    const suffix = await fileResponse(
      new Request("https://local/file", { headers: { Range: "bytes=-3" } }),
      file,
    );
    assert.equal(await suffix.text(), "789");
    const invalid = await fileResponse(
      new Request("https://local/file", { headers: { Range: "bytes=99-" } }),
      file,
    );
    assert.equal(invalid.status, 416);
    const html = path.join(archive, "page.html");
    await writeFile(html, "<script>window.bad=true</script>");
    const untrusted = await fileResponse(
      new Request("https://local/file"),
      html,
    );
    assert.match(untrusted.headers.get("Content-Security-Policy"), /^sandbox;/);
    await untrusted.text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("libraries in synced folders are recognized", () => {
  const home = path.join(path.sep, "home", "a"),
    at = (...p) => path.join(home, ...p),
    check = (folder, options = {}) => cloudService(folder, { home, env: {}, exists: () => false, ...options });
  assert.equal(check(at("Library", "Mobile Documents", "com~apple~CloudDocs", "Obelisk")), "iCloud Drive");
  assert.equal(check(at("Documents", "Obelisk")), null);
  assert.equal(check(at("Documents", "Obelisk"), { exists: () => true }), "iCloud Drive", "Desktop & Documents sync");
  assert.equal(check(at("Library", "CloudStorage", "GoogleDrive-me", "My Drive", "Obelisk")), "Google Drive");
  assert.equal(check(at("Dropbox", "Obelisk")), "Dropbox");
  assert.equal(check(at("Work", "Obelisk"), { env: { OneDrive: at("Work") } }), "OneDrive");
  assert.equal(check(at("Obelisk")), null);
});
