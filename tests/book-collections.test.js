import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {check, readBundle} from "../packages/collections/format.js";
import {collectionPlans} from "../packages/collections/plans.js";

const ids = ["a-first-shelf-of-classics", "poetry-and-plays", "ideas-and-history", "practical-knowledge"];
test("four curated EPUB collections ship their full selection with usable, attributed download plans", async () => {
  const bundle = readBundle(JSON.parse(await readFile(new URL("../collections/collections.json", import.meta.url), "utf8")));
  const urls = new Set();
  let total = 0;
  for (const id of ids) {
    const c = JSON.parse(await readFile(new URL(`../collections/books/${id}.json`, import.meta.url), "utf8"));
    assert.deepEqual(check(c, {strict: true}), [], id);
    assert.deepEqual(bundle.collections.find((item) => item.id === id), c, "the app receives the reviewed selection");
    const plans = collectionPlans(c);
    assert.equal(plans.length, c.entries.length);
    if (id === "a-first-shelf-of-classics") {
      assert.equal(c.title, "World literature");
      assert.ok(c.entries.length >= 200, "world literature has at least 200 EPUBs");
      for (const existing of ["pride-and-prejudice", "jane-eyre", "frankenstein", "moby-dick"])
        assert.ok(c.entries.some((entry) => entry.id === existing), "existing entries keep their identity");
    }
    for (const [index, entry] of c.entries.entries()) {
      assert.ok(!urls.has(entry.url), "no duplicate editions across collections");
      urls.add(entry.url);
      assert.ok(entry.creator && entry.rights && entry.source, "credit and source survive selection");
      assert.equal(plans[index].type, "document");
      assert.equal(plans[index].kind, "book");
      assert.ok(plans[index].filename.endsWith(".epub"));
      assert.equal(plans[index].expectedBytes, entry.bytes);
      assert.equal(plans[index].expectedSha256, entry.sha256);
      assert.equal(plans[index].source.url, entry.source);
      assert.equal(plans[index].rights, entry.rights);
    }
    total += c.entries.length;
  }
  assert.ok(total >= 400 && total < 500, "hundreds of curated works, including separate volumes");
});
