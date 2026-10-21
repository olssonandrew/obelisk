import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openZim } from "../desktop/zim/engine.js";
import { zimHeader } from "../desktop/zim/header.js";
import { createZimReader } from "../desktop/zim/service.js";
import { writeZim } from "./helpers/zim-fixture.js";

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "obelisk-zim-"));
  try {
    const filename = path.join(dir, "fixture.zim");
    await writeZim(filename);
    await fn(filename);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("ZIM engine reads legacy welcome pages, Unicode, redirects and suggestions without changing files", () =>
  fixture(async (filename) => {
    const before = await readFile(filename),
      z = await openZim(filename);
    try {
      assert.equal(z.info.home, "A/Welcome");
      assert.equal(z.info.articles, 3);
      assert.match(
        Buffer.from((await z.entry("A/Café")).content).toString(),
        /Café/,
      );
      assert.equal((await z.entry("A/Alias")).redirect, "A/Second");
      assert.equal((await z.entry("I/pixel.svg")).mime, "image/svg+xml");
      assert.deepEqual(await z.search("Sec"), [
        { path: "A/Second", title: "Second" },
      ]);
      assert.equal(await z.entry("A/Missing"), null);
      await assert.rejects(z.search("x".repeat(257)), /256/);
      await assert.rejects(z.entry("\0"), /Invalid/);
    } finally {
      z.close();
    }
    await assert.rejects(z.entry("A/Welcome"), /closed/);
    assert.deepEqual(await readFile(filename), before);
  }));
test("ZIM header rejects truncated, non-ZIM and out-of-bounds welcome entries", () =>
  fixture(async (filename) => {
    const bytes = await readFile(filename);
    for (const invalid of [
      Buffer.from("not a ZIM"),
      Buffer.alloc(80),
      bytes.subarray(0, 100),
    ]) {
      await writeFile(filename, invalid);
      await assert.rejects(zimHeader(filename));
    }
    bytes.writeUInt32LE(999999, 64);
    await writeFile(filename, bytes);
    await assert.rejects(openZim(filename), /Invalid ZIM welcome/);
  }));
test("ZIM service scopes tokens, follows redirects, supports ranges and invalidates previous readers", () =>
  fixture(async (filename) => {
    const item = { id: "demo", filename: "fixture.zim" };
    const library = { resolveItem: async () => ({ filename, item }) };
    const service = createZimReader(() => library);
    try {
      const info = await service.open("demo");
      const request = (suffix, init) =>
        service.response(
          new Request(`obelisk://zim/${info.token}/${suffix}`, init),
        );
      assert.deepEqual(await (await request("search?q=Sec")).json(), [
        { path: "A/Second", title: "Second" },
      ]);
      assert.equal((await request("content/A/Alias")).status, 302);
      assert.equal((await request("content/A/Missing")).status, 404);
      assert.equal(
        (await request("content/A/Second", { method: "POST" })).status,
        405,
      );
      const range = await request("content/A/Second", {
        headers: { Range: "bytes=0-3" },
      });
      assert.equal(range.status, 206);
      assert.equal(await range.text(), "<h1>");
      const next = await service.open("demo");
      assert.equal((await request("content/A/Second")).status, 410);
      service.close(info.token);
      assert.equal(
        (
          await service.response(
            new Request(`obelisk://zim/${next.token}/content/A/Second`),
          )
        ).status,
        200,
      );
      service.close();
      assert.equal((await request("content/A/Second")).status, 410);
    } finally {
      service.close();
    }
  }));
test("bundled OpenZIM runtime matches the pinned upstream checksums", async () => {
  const base = new URL("../desktop/zim/vendor/", import.meta.url);
  const source = JSON.parse(
    await readFile(new URL("SOURCE.json", base), "utf8"),
  );
  for (const [name, hash] of Object.entries(source.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL(name, base)))
        .digest("hex"),
      hash,
    );
});
