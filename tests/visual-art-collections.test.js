import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { check, readBundle } from "../packages/collections/format.js";
import { collectionPlans } from "../packages/collections/plans.js";

const ids = ["art-institute-paintings", "drawing-through-the-centuries", "photography-invention-to-documentary"];

test("the shipped visual art collections offer 780 distinct files with preserved attribution", async () => {
  const bundle = JSON.parse(await readFile(new URL("../collections/collections.json", import.meta.url), "utf8"));
  const shipped = readBundle(bundle).collections;
  const urls = new Set();
  const hashes = new Set();
  for (const id of ids) {
    const c = JSON.parse(await readFile(new URL(`../collections/images/${id}.json`, import.meta.url), "utf8"));
    assert.deepEqual(check(c, { strict: true }), [], id);
    assert.deepEqual(shipped.find((item) => item.id === id), c, "the app must receive the reviewed collection");
    assert.equal(c.entries.length, id === "art-institute-paintings" ? 300 : 240, id);
    const plans = collectionPlans(c);
    assert.equal(plans.length, c.entries.length);
    for (const [i, entry] of c.entries.entries()) {
      assert.ok(entry.creator && entry.date && entry.description, `${id}/${entry.id}: attribution and context`);
      assert.ok(!urls.has(entry.url), `repeated download: ${entry.url}`);
      assert.ok(!hashes.has(entry.sha256), `repeated image: ${id}/${entry.id}`);
      urls.add(entry.url);
      hashes.add(entry.sha256);
      const plan = plans[i];
      assert.equal(plan.type, "image");
      assert.equal(plan.creator, entry.creator);
      assert.equal(plan.created, entry.date);
      assert.equal(plan.rights, entry.rights);
      assert.equal(plan.description, entry.description);
      assert.equal(plan.source.url, entry.source);
      assert.equal(plan.expectedBytes, entry.bytes);
      assert.equal(plan.expectedSha256, entry.sha256);
    }
  }
  assert.equal(urls.size, 780);
});

test("the visual art survey includes the major painting and original print additions", async () => {
  const { collections } = JSON.parse(await readFile(new URL("../collections/collections.json", import.meta.url), "utf8"));
  const paintings = collections.find((c) => c.id === ids[0]);
  assert.equal(paintings.title, "Paintings across cultures");
  for (const creator of ["Leonardo da Vinci", "Raphael", "Sandro Botticelli", "Johannes Vermeer", "Pieter Bruegel", "Gustav Klimt", "Artemisia Gentileschi"])
    assert.ok(paintings.entries.some((e) => e.creator.includes(creator)), creator);
  for (const title of ["Mona Lisa", "The Birth of Venus", "The School of Athens", "The Night Watch", "The Starry Night"])
    assert.ok(paintings.entries.some((e) => e.title === title), title);
  const paper = collections.find((c) => c.id === ids[1]);
  assert.equal(paper.title, "Drawings and prints");
  for (const id of ["met-45434", "nga-6640", "nga-7502", "nga-9970", "nga-11546"])
    assert.ok(paper.entries.some((e) => e.id === id), `missing original print ${id}`);
});
