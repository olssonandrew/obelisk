// Checks the collections in collections/ and builds the one file the app reads.
//
//   npm run collections                     check every collection and rebuild collections.json
//   npm run collections -- --fill <file>    also download new files once to fill in size and checksum
//   npm run collections -- --online         also confirm every address answers as it should
//   npm run collections -- --verify         CI: fail if collections.json is out of date (writes nothing)
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";
import { check, sniff, TYPES, FORMAT, sizeOf, isFileType } from "../packages/collections/format.js";
import { USER_AGENT } from "../packages/core/http-transfer.js";
import { waybackNear } from "../packages/sources/web.js";
import { parsePodcast } from "../packages/sources/podcasts.js";

// Distant servers need longer than Node's default quarter second per address to answer.
setDefaultAutoSelectFamilyAttemptTimeout(2500);
const root = fileURLToPath(new URL("../collections/", import.meta.url));
const args = process.argv.slice(2),
  fill = args.includes("--fill"),
  online = args.includes("--online"),
  verify = args.includes("--verify"),
  only = args.filter((a) => !a.startsWith("--")).map((a) => path.resolve(a));
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Like the app: three seconds between requests to one server, and when it says "slow down"
// or has a passing fault, waiting as long as it asks (or longer each time) and trying again.
const lastAsked = new Map();
async function ask(url, init = {}) {
  const host = new URL(url).hostname;
  for (let attempt = 1; ; attempt++) {
    const since = Date.now() - (lastAsked.get(host) || 0);
    if (since < 3000) await pause(3000 - since);
    lastAsked.set(host, Date.now());
    const response = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(init.timeout || 60000) });
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) return response;
    await response.body?.cancel();
    const asked = Number(response.headers.get("retry-after"));
    const wait = Math.min(300, Math.max(Number.isFinite(asked) ? asked : 0, 60 * attempt));
    process.stdout.write(`(HTTP ${response.status}, waiting ${wait} s) `);
    await pause(wait * 1000);
  }
}

async function files() {
  const out = [];
  for (const type of await readdir(root, { withFileTypes: true }))
    if (type.isDirectory())
      for (const name of await readdir(path.join(root, type.name)))
        if (name.endsWith(".json")) out.push(path.join(root, type.name, name));
  return out.sort();
}

/** Downloads a file once, checking what it is and working out its size and checksum. */
async function measure(entry, formats) {
  const response = await ask(entry.url, { timeout: 30 * 60000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0,
    head = Buffer.alloc(0);
  for await (const chunk of response.body) {
    if (head.length < 64) head = Buffer.concat([head, chunk]);
    hash.update(chunk);
    bytes += chunk.length;
  }
  const found = sniff(head);
  if (!formats.includes(found)) throw new Error(found === "html" ? "the address returns a web page, not the file" : `it's ${found || "an unknown format"}, not ${formats.join(" or ")}`);
  return { bytes, sha256: hash.digest("hex") };
}

/** Confirms an entry answers as it should, without downloading whole files. */
async function probe(c, entry) {
  if (c.type === "podcasts") {
    const response = await ask(entry.feed);
    if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`);
    const feed = parsePodcast(await response.text(), entry.feed);
    if (!feed.episodes.length) throw new Error("the feed has no episodes");
    return;
  }
  if (c.type === "websites") {
    for (const date of entry.dates) {
      if (date === "live") {
        const response = await ask(entry.url, { method: "GET" });
        await response.body?.cancel();
        if (response.status >= 400) throw new Error(`the live page returned HTTP ${response.status}`);
      } else if (!(await waybackNear(entry.url, `${date.replace(/-/g, "")}120000`))) throw new Error(`the Wayback Machine has no copy near ${date}`);
    }
    return;
  }
  const response = await ask(entry.url, { headers: { Range: "bytes=0-63" } });
  const head = Buffer.from(await response.arrayBuffer()).subarray(0, 64);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const found = sniff(head);
  if (!TYPES[c.type].formats.includes(found)) throw new Error(found === "html" ? "returns a web page, not the file" : `it's ${found || "an unknown format"}`);
  const length = Number(/\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1] || response.headers.get("content-length"));
  if (response.status === 206 && length && entry.bytes && length !== entry.bytes) throw new Error(`the file is now ${length} bytes, not ${entry.bytes}; it has changed`);
}

let failed = false;
const say = (file, text) => console.log(`${path.relative(process.cwd(), file)}: ${text}`);
const collections = [];
for (const file of await files()) {
  let c;
  try {
    c = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    say(file, `isn't valid JSON (${e.message})`);
    failed = true;
    continue;
  }
  const mine = !only.length || only.includes(file);
  if (path.basename(file, ".json") !== c.id) say(file, `the file name must match its id, "${c.id}"`), (failed = true);
  if (path.basename(path.dirname(file)) !== c.type) say(file, `it must be in collections/${c.type}/`), (failed = true);
  if (fill && mine && isFileType(c.type)) {
    let changed = false;
    for (const entry of c.entries || []) {
      if (Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.sha256) continue;
      process.stdout.write(`  ${c.id}/${entry.id} … `);
      try {
        Object.assign(entry, await measure(entry, TYPES[c.type].formats));
        changed = true;
        console.log(size(entry.bytes));
      } catch (e) {
        console.log(`failed: ${e.message}`);
        failed = true;
      }
    }
    if (changed) await writeFile(file, JSON.stringify(c, null, 2) + "\n");
  }
  const problems = check(c, { strict: true });
  for (const p of problems) say(file, p);
  if (problems.length) {
    failed = true;
    continue;
  }
  if (online && mine) {
    for (const entry of c.entries) {
      try {
        await probe(c, entry);
      } catch (e) {
        say(file, `${entry.id}: ${e.message}`);
        failed = true;
      }
    }
  }
  collections.push(c);
}

let featured = [];
try {
  featured = JSON.parse(await readFile(path.join(root, "featured.json"), "utf8")).featured || [];
} catch {}
for (const id of featured) if (!collections.some((c) => c.id === id && c.type !== "podcasts")) console.log(`featured.json: "${id}" isn't a collection that can be featured`), (failed = true);
// Podcasts have one list of recommended shows; new shows are added to it.
const lists = collections.filter((c) => c.type === "podcasts");
if (lists.length > 1) console.log(`podcasts: there's one list of shows. Add them to collections/podcasts/${lists[0].id}.json instead.`), (failed = true);

// The date of the latest change tells copies of the list apart; nothing else in it
// changes from one build to the next, so an unchanged list builds byte for byte the same.
const bundle = {
  format: FORMAT,
  built: collections.map((c) => c.updated).sort().pop() || null,
  featured,
  collections: collections.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title)),
};
const out = path.join(root, "collections.json"),
  text = JSON.stringify(bundle) + "\n";
const before = await readFile(out, "utf8").catch(() => "");
if (verify) {
  if (before !== text) console.log("collections/collections.json is out of date. Run npm run collections and commit it."), (failed = true);
} else if (!failed && before !== text) await writeFile(out, text);

for (const c of collections) console.log(`✓ ${c.type}/${c.id}: ${c.entries.length} ${TYPES[c.type].noun[c.entries.length === 1 ? 0 : 1]}${isFileType(c.type) ? `, ${size(sizeOf(c))}` : ""}`);
if (failed) {
  console.log("\nFix the problems above, then run this again.");
  process.exit(1);
}
