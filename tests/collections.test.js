import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { check, sniff, readBundle, entryKeys } from "../packages/collections/format.js";
import { collectionPlans } from "../packages/collections/plans.js";
import { createCollectionSource } from "../packages/collections/source.js";
import { openCatalog } from "../packages/core/catalog.js";
import { createDownloads } from "../packages/core/downloads.js";
import { openLibrary } from "../packages/core/library.js";

async function until(condition, message, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(message);
}
const FAST = { busy: { tries: 4, base: 0.05, cap: 1 }, offline: { tries: 3, base: 0.05, cap: 1 } };
const JPEG = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, n)]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A test server: `routes` maps a path to a function that answers each request to it. */
async function serve(routes) {
  const hits = {};
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const route = routes[req.url];
    if (!route) return res.writeHead(404).end("missing");
    route(req, res, hits[req.url]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
    hits,
    close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))),
  };
}
const file = (body) => (req, res) => res.writeHead(200, { "Content-Length": body.length }).end(body);
function collection(base, entries, extra = {}) {
  return {
    id: "test-paintings",
    type: "images",
    title: "Test paintings",
    summary: "Paintings for a test.",
    topics: ["art"],
    language: "zxx",
    curator: "Tests",
    updated: "2026-10-15",
    parallel: 1,
    entries: entries.map(([id, body]) => ({
      id,
      title: `Painting ${id}`,
      creator: "Someone",
      date: "1890",
      url: base(`/${id}.jpg`),
      source: base(`/about/${id}`),
      rights: "Public domain",
      bytes: body.length,
      sha256: sha(body),
    })),
    ...extra,
  };
}

test("the format check names each problem, and the bundle reader skips only what it must", () => {
  const good = collection((p) => `https://example.org${p}`, [["one", JPEG(1)], ["two", JPEG(2)]]);
  assert.deepEqual(check(good, { strict: true }), []);
  const bad = { ...good, id: "Bad Id", topics: ["cooking"], updated: "2026-13-40", entries: [{ ...good.entries[0], url: "ftp://x", sha256: "abc" }, good.entries[0]] };
  const problems = check(bad, { strict: true }).join("\n");
  for (const words of ["id:", "topics:", "updated:", "url:", "sha256:", "is used twice"]) assert.match(problems, new RegExp(words));
  // A contributor's draft, before the fill command, has no size or checksum yet.
  const draft = { ...good, entries: [{ ...good.entries[0], bytes: 0, sha256: "" }] };
  assert.notDeepEqual(check(draft), []);
  assert.deepEqual(check(draft, { draft: true }), []);
  assert.match(check({ ...good, extra: 1 }, { strict: true }).join(), /unknown field/);
  assert.deepEqual(check({ ...good, extra: 1 }), [], "the app ignores fields from newer versions");
  const websites = { ...good, type: "websites", entries: [{ id: "a", title: "A", url: "https://a.org/", dates: ["1995-01-01", "live", "live"] }] };
  assert.match(check(websites).join(), /lists a date twice/);
  assert.match(check(websites).join(), /from 1996 on/);
  const read = readBundle({ format: 1, built: "2026-10-15", featured: ["test-paintings", "gone"], collections: [good, bad, { ...good, id: "future", type: "holograms" }] });
  assert.deepEqual(read.collections.map((c) => c.id), ["test-paintings"]);
  assert.deepEqual(read.skipped.map((s) => s.id), ["Bad Id"]);
  assert.deepEqual(read.featured, ["test-paintings"]);
  assert.throws(() => readBundle({ format: 2, collections: [] }), /can read/);
});

test("files are recognized by their first bytes, so a web page can't pass for a book", () => {
  assert.equal(sniff(Buffer.from("%PDF-1.7\n")), "pdf");
  const epub = Buffer.alloc(64);
  epub.write("PK\x03\x04", 0, "latin1");
  epub.write("mimetypeapplication/epub+zip", 30, "latin1");
  assert.equal(sniff(epub), "epub");
  assert.equal(sniff(JPEG(0)), "jpeg");
  assert.equal(sniff(Buffer.from("\n  <!DOCTYPE html><html><body>Access denied")), "html");
  assert.equal(sniff(Buffer.from("ID3\x04\x00")), "mp3");
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), "matroska");
});

test("entries become the plans their importers make: one per file, one per website date", () => {
  const images = collection((p) => `https://example.org${p}`, [["one", JPEG(1)]]);
  const [plan] = collectionPlans(images);
  assert.equal(plan.filename, "Painting one.jpg");
  assert.equal(plan.expectedSha256, images.entries[0].sha256);
  assert.deepEqual(plan.formats, ["jpeg", "png", "tiff", "webp", "gif"]);
  assert.equal(plan.group.parallel, 1);
  assert.deepEqual(plan.source.collection, { id: "test-paintings", type: "images", title: "Test paintings", curator: "Tests", entry: "one", key: "one" });
  const web = { ...images, type: "websites", entries: [{ id: "yahoo", title: "Yahoo!", url: "http://www.yahoo.com/", dates: ["1996-12-20", "live"] }] };
  assert.deepEqual(entryKeys(web, web.entries[0]), ["yahoo@1996-12-20", "yahoo@live"]);
  const plans = collectionPlans(web);
  assert.deepEqual(plans.map((p) => p.snapshot), ["19961220120000", null]);
  assert.deepEqual(collectionPlans(web, ["yahoo@live"]).map((p) => p.source.collection.key), ["yahoo@live"]);
  assert.deepEqual(collectionPlans({ ...images, type: "podcasts", entries: [] }), []);
});

test("a server that asks Obelisk to slow down is waited on, then the download carries on by itself", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-busy-"));
  const catalog = openCatalog(root),
    body = JPEG(7);
  const server = await serve({
    "/a.jpg": (req, res, n) => (n === 1 ? res.writeHead(429, { "Retry-After": "1" }).end("slow down") : file(body)(req, res)),
    "/b.jpg": file(body),
  });
  const downloads = createDownloads({ catalog, root, archiveRoot: path.join(root, "archive"), onChange: async () => {}, retry: FAST });
  try {
    const group = { id: "collection:t", title: "T", parallel: 2 };
    const [a, b] = downloads.addPlans(["/a.jpg", "/b.jpg"].map((p) => ({ url: server.url(p), filename: p.slice(1), title: p, formats: ["jpeg"], group })));
    await until(() => catalog.job(a.id).status === "waiting", "No wait recorded");
    const waiting = catalog.job(a.id);
    assert.equal(waiting.failure, "busy");
    assert.ok(waiting.retryAt > Date.now() + 500, "it waits as long as the server asked");
    assert.match(waiting.error, /asked Obelisk to slow down/);
    // Everything from that server waits, not just the file that was turned away.
    assert.equal(catalog.job(b.id).status, "queued");
    assert.equal(server.hits["/b.jpg"], undefined);
    await until(() => catalog.job(a.id).status === "complete" && catalog.job(b.id).status === "complete", "Did not carry on after waiting", 6000);
    assert.equal(server.hits["/a.jpg"], 2);
  } finally {
    await downloads.stop();
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dropped connections are retried; refusals, missing files and stand-in web pages are not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-refused-"));
  const catalog = openCatalog(root),
    body = JPEG(3);
  let blocking = true;
  const refuse = (req, res) => (blocking ? res.writeHead(403).end() : file(body)(req, res));
  const server = await serve({
    "/flaky.jpg": (req, res, n) => (n === 1 ? req.socket.destroy() : file(body)(req, res)),
    "/page.jpg": (req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><html><body>Please verify you are human</body></html>"),
    "/r1.jpg": refuse,
    "/r2.jpg": refuse,
    "/r3.jpg": refuse,
    "/r4.jpg": file(body),
  });
  const downloads = createDownloads({ catalog, root, archiveRoot: path.join(root, "archive"), onChange: async () => {}, retry: FAST, spacing: 0 });
  try {
    const plan = (p, group) => ({ url: server.url(p), filename: p.slice(1), title: p, formats: ["jpeg"], ...(group ? { group } : {}) });
    const flaky = downloads.addPlan(plan("/flaky.jpg"));
    const page = downloads.addPlan(plan("/page.jpg"));
    const missing = downloads.addPlan(plan("/missing.jpg"));
    await until(() => catalog.job(flaky.id).status === "complete", "A dropped connection was not retried");
    await until(() => catalog.job(page.id).status === "failed", "A web page passed for a file");
    assert.equal(catalog.job(page.id).failure, "refused");
    assert.match(catalog.job(page.id).error, /sent a web page instead of the file/);
    await until(() => catalog.job(missing.id).status === "failed", "A missing file was not reported");
    assert.equal(catalog.job(missing.id).failure, "gone");
    assert.equal(server.hits["/missing.jpg"], 1, "a missing file is asked for once");
    // Three refusals in a row from one server stop the rest of that collection's files from it.
    const group = { id: "collection:r", title: "R", parallel: 1 };
    const jobs = downloads.addPlans(["/r1.jpg", "/r2.jpg", "/r3.jpg", "/r4.jpg"].map((p) => plan(p, group)));
    await until(() => catalog.job(jobs[3].id).status === "paused", "The rest kept knocking");
    assert.equal(server.hits["/r4.jpg"], undefined);
    assert.equal(catalog.job(jobs[3].id).failure, "refused");
    assert.match(catalog.job(jobs[3].id).error, /is refusing downloads/);
    // Later the server lets downloads through again, and resuming the collection finishes it.
    blocking = false;
    await downloads.group("collection:r", "resume");
    await until(() => jobs.every((j) => catalog.job(j.id).status === "complete"), "Resuming the group did not carry on");
  } finally {
    await downloads.stop();
    await server.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a collection saves into its own folder, never twice, and marks only later entries as new", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-collection-"));
  const bodies = { one: JPEG(1), two: JPEG(2), three: JPEG(3) };
  const server = await serve(Object.fromEntries(Object.entries(bodies).map(([id, b]) => [`/${id}.jpg`, file(b)])));
  let library = await openLibrary(path.join(root, "lib"), undefined, { retry: FAST, spacing: 0 });
  try {
    const c = collection(server.url, Object.entries(bodies));
    // Images was renamed, so it may mean something else now: the collection starts a new Images folder.
    const images = library.state().folders.find((f) => f.name === "Images" && !f.parent);
    await library.folders.rename(images.id, "Pictures");
    await library.collections.save(c, ["one", "two"]);
    await until(() => Object.values(library.collections.status([c])["test-paintings"].entries).filter((e) => e.state === "saved").length === 2, "Not saved");
    let status = library.collections.status([c])["test-paintings"];
    assert.equal(status.entries.three, undefined, "an entry left unticked isn't new");
    const folder = library.state().folders.find((f) => f.id === status.folder);
    assert.equal(folder.name, "Test paintings");
    assert.equal(library.state().folders.find((f) => f.id === folder.parent).name, "Images");
    assert.ok(library.state().folders.some((f) => f.name === "Pictures" && !f.parent), "the renamed folder is left alone");
    const one = library.catalog.get(status.entries.one.itemId);
    assert.equal(one.creator, "Someone");
    assert.equal(one.source.collection.curator, "Tests");
    assert.deepEqual(await readFile(path.join(library.archiveRoot, one.path)), bodies.one);
    // Saving everything again only fetches what's missing.
    await library.collections.save(c);
    await until(() => library.collections.status([c])["test-paintings"].entries.three?.state === "saved", "The missing one was not saved");
    assert.deepEqual([server.hits["/one.jpg"], server.hits["/two.jpg"], server.hits["/three.jpg"]], [1, 1, 1]);
    // The folder can be renamed and moved; the collection still finds it.
    await library.folders.rename(folder.id, "Museum");
    await library.folders.move(folder.id, null);
    // A deleted file is just not saved; only entries added later are new.
    await library.removeItems([status.entries.two.itemId], async (target) => rm(target, { recursive: true, force: true }));
    const grown = collection(server.url, [...Object.entries(bodies), ["four", JPEG(4)]]);
    status = library.collections.status([grown])["test-paintings"];
    assert.equal(status.entries.two, undefined);
    assert.equal(status.entries.four.state, "new");
    assert.equal(status.folder, folder.id);
    await library.close();
    library = await openLibrary(path.join(root, "lib"), undefined, { retry: FAST, spacing: 0 });
    assert.equal(library.collections.status([grown])["test-paintings"].entries.four.state, "new", "remembered after reopening");
  } finally {
    await library.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the newest list wins: published over shipped, and a withdrawn collection goes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-list-"));
  const one = collection((p) => `https://example.org${p}`, [["one", JPEG(1)]]),
    two = { ...one, id: "second" };
  await writeFile(path.join(root, "shipped.json"), JSON.stringify({ format: 1, built: "2026-10-01", featured: [], collections: [one, two] }));
  let calls = 0;
  const published = { format: 1, built: "2026-10-15", featured: ["test-paintings"], collections: [one] };
  const fetchImpl = async (url, init) => {
    calls++;
    if (init.headers["If-None-Match"] === '"v2"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify(published), { headers: { ETag: '"v2"' } });
  };
  try {
    const source = createCollectionSource({ bundled: path.join(root, "shipped.json"), cacheFile: path.join(root, "cache.json"), url: "https://example.org/collections.json", fetch: fetchImpl });
    assert.deepEqual((await source.load()).collections.map((c) => c.id), ["test-paintings", "second"]);
    assert.equal(await source.refresh(), true);
    assert.deepEqual((await source.load()).collections.map((c) => c.id), ["test-paintings"]);
    assert.equal(await source.refresh(), false, "asked at most once a day");
    assert.equal(await source.refresh(true), false, "an unchanged list is a 304");
    assert.equal(calls, 2);
    // A later launch starts from the cached list, offline.
    const offline = createCollectionSource({ bundled: path.join(root, "shipped.json"), cacheFile: path.join(root, "cache.json"), url: "", fetch: async () => { throw new Error("offline"); } });
    assert.deepEqual((await offline.load()).featured, ["test-paintings"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming follows a link the collection has fixed since", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-fixed-"));
  const body = JPEG(9);
  const server = await serve({ "/old.jpg": (req, res) => res.writeHead(403).end(), "/new.jpg": file(body) });
  const library = await openLibrary(path.join(root, "lib"), undefined, { retry: FAST, spacing: 0 });
  try {
    const before = collection(server.url, [["one", body]]);
    before.entries[0].url = server.url("/old.jpg");
    await library.collections.save(before);
    await until(() => library.collections.status([before])["test-paintings"].entries.one?.state === "failed", "The refusal was not recorded");
    const after = collection(server.url, [["one", body]]);
    after.entries[0].url = server.url("/new.jpg");
    await library.collections.resume(after);
    await until(() => library.collections.status([after])["test-paintings"].entries.one?.state === "saved", "Resume kept the old link");
    assert.equal(server.hits["/new.jpg"], 1);
  } finally {
    await library.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a collection whose importer folder was deleted gets the default folder made again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obelisk-home-"));
  const server = await serve({ "/one.jpg": file(JPEG(1)) });
  const library = await openLibrary(path.join(root, "lib"), undefined, { retry: FAST, spacing: 0 });
  try {
    const images = library.state().folders.find((f) => f.name === "Images" && !f.parent);
    await library.folders.remove(images.id, { keep: false, trash: async (target) => rm(target, { recursive: true, force: true }) });
    const c = collection(server.url, [["one", JPEG(1)]]);
    await library.collections.save(c);
    await until(() => library.collections.status([c])["test-paintings"].entries.one?.state === "saved", "Not saved");
    const folder = library.state().folders.find((f) => f.id === library.collections.status([c])["test-paintings"].folder);
    assert.equal(library.state().folders.find((f) => f.id === folder.parent).name, "Images");
  } finally {
    await library.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
