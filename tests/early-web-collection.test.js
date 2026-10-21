import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { check, entryKeys, readBundle } from "../packages/collections/format.js";
import { collectionPlans } from "../packages/collections/plans.js";

const read = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));

test("the early-web collection ships 68 distinct date choices as web download plans", async () => {
  const c = await read("collections/websites/the-early-web.json");
  const shipped = readBundle(await read("collections/collections.json")).collections.find((item) => item.id === c.id);
  assert.deepEqual(check(c, { strict: true }), []);
  assert.deepEqual(shipped, c, "the app receives the maintained selection");
  assert.equal(c.entries.length, 50);
  const plans = collectionPlans(c);
  assert.equal(plans.length, 68);
  const keys = new Set();
  for (const entry of c.entries) {
    assert.ok(entry.note, "each page has a reason to be included");
    for (const [index, key] of entryKeys(c, entry).entries()) {
      assert.ok(!keys.has(key), "each choice is saved once");
      keys.add(key);
      const plan = plans.find((item) => item.source.collection.key === key);
      const date = entry.dates[index];
      assert.equal(plan.url, entry.url);
      assert.equal(plan.driver, "web");
      assert.equal(plan.source.collection.date, date);
      if (date === "live") {
        assert.equal(plan.snapshot, null);
        assert.match(entry.note, /restored|served today/);
      } else {
        assert.ok(date >= "1996-01-01" && date <= "2005-12-31");
        assert.equal(plan.snapshot, `${date.replaceAll("-", "")}120000`);
      }
    }
  }
  assert.equal(keys.size, 68);
  assert.equal(plans.filter((plan) => plan.snapshot === null).length, 2);
});

test("the web survey keeps the original subjects and uses historically appropriate addresses", async () => {
  const c = await read("collections/websites/the-early-web.json");
  const entries = new Map(c.entries.map((entry) => [entry.id, entry]));
  for (const id of ["the-first-website", "space-jam", "yahoo", "google", "amazon", "apple", "nasa", "ebay", "wikipedia"])
    assert.ok(entries.has(id), `original entry identity: ${id}`);
  for (const id of ["ncsa-mosaic", "mozilla", "w3c", "internet-archive", "eff", "geocities", "slashdot", "project-gutenberg", "american-memory", "coffee-pot", "yahoo-japan", "uol", "sina", "naver", "rediff", "al-jazeera"])
    assert.ok(entries.has(id), `historical coverage: ${id}`);
  assert.equal(entries.get("salon").url, "http://www.salonmagazine.com/", "the early salon.com was a different business");
  assert.deepEqual(entries.get("amazon").dates, ["2000-11-09"], "keep the corrected historical date instead of the misleading 1999 target");
  assert.equal(entries.get("rediff").url, "http://www.rediff.com/index.asp", "save the news page, not a meta-refresh stub");
  assert.deepEqual(entries.get("white-house").dates, ["2001-01-18", "2001-02-02"], "captures bracket the actual presidential transition");
  assert.ok(entries.get("mozilla").dates.includes("2004-11-09"), "Firefox 1.0 release page");
  assert.ok(entries.get("pets-com").dates.includes("2000-11-10"), "the closure notice is part of the dot-com record");
  assert.ok(entries.get("apple").dates.includes("2001-10-24"), "the iPod-era comparison");
});
