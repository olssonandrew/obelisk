// Builds a full demo library from public-domain and openly licensed content, for
// screenshots and hands-on testing. Downloads are cached, so a rebuild is quick.
//   npm run demo:library            builds demo/My Library and opens it next launch
//   npm run demo:library -- --fresh rebuilds it from scratch (keeps the cache)
import { _electron as electron } from "playwright-core";
import { mkdir, writeFile, readFile, rm, access, stat, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLibrary } from "../packages/core/library.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = path.join(root, "demo");
const cache = path.join(home, ".cache");
const library = path.join(home, "My Library");
const agent = "Obelisk-demo/1.0 (https://github.com/; demo library builder)";
const run = promisify(execFile);
const exists = (file) => access(file).then(() => true, () => false);
const log = (...args) => console.log(...args);

// What goes where. Folder paths are display names under the library's root.
const FOLDERS = [
  ["Images/Art", "palette"],
  ["Images/Space", "star"],
  ["Audio/Music/Piano", "music"],
  ["Audio/Music/Strings", "music"],
  ["Documents/Books/Classics", "book"],
  ["Documents/NASA", "flag"],
  ["Documents/Notes", "text"],
  ["Video/Blender films", "film"],
];

const ART = [
  // Art Institute of Chicago open access (CC0). A few that look nothing alike.
  [24645, "Art", ["japan", "ukiyo-e"], { favorite: true, rating: 5 }],
  [28560, "Art", ["impressionism"], { favorite: true, rating: 5 }],
  [16568, "Art", ["impressionism", "gardens"], { rating: 4 }],
  [27992, "Art", ["impressionism"], { rating: 5 }],
  [20684, "Art", ["paris"]],
];
const SPACE = [
  // NASA (public domain).
  ["carina_nebula", "Cosmic Cliffs in the Carina Nebula", ["space", "webb"], { favorite: true, rating: 5 }],
  ["southern_ring_nebula", "Southern Ring Nebula", ["space", "webb"]],
  ["as08-14-2383", "Earthrise", ["space", "apollo"], { favorite: true }],
  ["as17-148-22727", "The Blue Marble", ["space", "apollo"]],
  ["iss072e159172", "Aurora over Earth", ["space", "earth"]],
];
const MUSIC = [
  // Wikimedia Commons (public domain or CC0/CC-BY recordings of public-domain works).
  ["File:Gymnopedie No. 1..ogg", "Piano", "Gymnopédie No. 1", "Erik Satie", ["classical", "calm"], { favorite: true }],
  ["File:Clair de lune (Claude Debussy) Suite bergamasque.ogg", "Piano", "Clair de lune", "Claude Debussy", ["classical", "calm"], { rating: 5 }],
  ["File:Chopin, Nocturne in C-sharp minor, Op. Posth.ogg", "Piano", "Nocturne in C-sharp minor", "Frédéric Chopin", ["classical"]],
  ["File:Bach - Cello Suite no. 1 in G major, BWV 1007 - I. Prélude.ogg", "Strings", "Cello Suite No. 1: Prélude", "J. S. Bach", ["classical"], { rating: 4 }],
  ["File:Vivaldi - Four Seasons 1 Spring mvt 1 Allegro - John Harrison violin.oga", "Strings", "Spring: Allegro", "Antonio Vivaldi", ["classical"]],
];
const BOOKS = [
  // Project Gutenberg (public domain), EPUB 3 with covers.
  [11, "Alice’s Adventures in Wonderland", "Lewis Carroll", "1865", { favorite: true }],
  [2701, "Moby-Dick", "Herman Melville", "1851"],
  [1342, "Pride and Prejudice", "Jane Austen", "1813", { rating: 5 }],
  [84, "Frankenstein", "Mary Shelley", "1818"],
  [64317, "The Great Gatsby", "F. Scott Fitzgerald", "1925"],
  [1661, "The Adventures of Sherlock Holmes", "Arthur Conan Doyle", "1892"],
];
const FILES = [
  // Blender open movies (CC-BY), NASA documents (public domain).
  ["https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4", "Blender films", "Sintel (trailer)", "Blender Foundation", "2010", ["film", "animation"], { favorite: true }],
  ["https://download.blender.org/peach/trailer/trailer_480p.mov", "Blender films", "Big Buck Bunny (trailer)", "Blender Foundation", "2008", ["film", "animation"]],
  ["https://archive.org/download/apollo-11-press-kit/apollo-11-press-kit.pdf", "NASA", "Apollo 11 press kit", "NASA", "1969-07-06", ["apollo", "space"], { rating: 4 }],
  ["https://www.nasa.gov/sites/default/files/atoms/files/earth_book_2019_tagged.pdf", "NASA", "Earth", "NASA", "2019", ["earth", "space"], { favorite: true }],
];
const NOTES = [
  ["Kyoto trip.md", `# Kyoto in April

- Philosopher’s Path at dawn, before the crowds
- Fushimi Inari: past the first gates it empties out
- Nishiki Market for lunch
- Offline map saved in Maps

## On the train
Moby-Dick, chapter one. Then sleep.
`, ["travel", "japan"], { favorite: true }],
];
const SITES = [
  ["https://apod.nasa.gov/apod/astropix.html", "Astronomy Picture of the Day", ["space"]],
  ["https://publicdomainreview.org/", "The Public Domain Review", ["art"]],
  ["https://en.wikipedia.org/wiki/The_Great_Wave_off_Kanagawa", "The Great Wave off Kanagawa", ["japan", "ukiyo-e"]],
  ["https://www.gutenberg.org/", "Project Gutenberg", ["reading"]],
  ["https://earthobservatory.nasa.gov/", "NASA Earth Observatory", ["space", "earth"]],
];
const MAPS = [
  ["Kyoto", [135.715, 34.96, 135.815, 35.05], 13],
  ["Lisbon", [-9.2, 38.69, -9.09, 38.77], 13],
  ["Monaco", [7.40, 43.72, 7.44, 43.755], 14],
];
const PODCAST = { query: "Houston We Have a Podcast", episodes: 1 };
const WIKIPEDIA = ["ray charles", "chemistry"];

async function fetchTo(url, file, accept = () => true) {
  if (await exists(file)) return file;
  await mkdir(path.dirname(file), { recursive: true });
  // curl, not fetch: some image servers turn away Node's requests.
  await run("curl", ["-fsSL", "--retry", "2", "-o", `${file}.part`, url]).catch((error) => {
    throw new Error(`${error.message.split("\n")[0]} for ${url}`);
  });
  const body = await readFile(`${file}.part`), magic = MAGIC[path.extname(file).toLowerCase()];
  if (!accept(body) || (magic && !magic(body))) {
    await rm(`${file}.part`, { force: true });
    throw new Error(`Not a ${path.extname(file)} file: ${url}`);
  }
  await rename(`${file}.part`, file);
  return file;
}
const json = async (url) => {
  const response = await fetch(url, { headers: { "user-agent": agent } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
};
// Servers sometimes answer with a web page instead of the file; check the format.
const MAGIC = {
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8,
  ".pdf": (b) => b.subarray(0, 4).toString() === "%PDF",
  ".epub": (b) => b.subarray(0, 2).toString() === "PK",
  ".ogg": (b) => b.subarray(0, 4).toString() === "OggS",
  ".oga": (b) => b.subarray(0, 4).toString() === "OggS",
  ".mp4": (b) => b.subarray(4, 8).toString() === "ftyp",
  ".mov": (b) => ["ftyp", "moov", "wide", "mdat"].includes(b.subarray(4, 8).toString()),
};
const safe = (name) => name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90);

/** Every local file, downloaded once into the cache. */
async function gather() {
  const out = [];
  const tryAdd = async (label, make) => {
    try {
      out.push(await make());
      log(`  ✓ ${label}`);
    } catch (error) {
      log(`  ✗ ${label}: ${error.message}`);
    }
  };
  log("Art");
  for (const [id, folder, tags, extra = {}] of ART)
    await tryAdd(`artic ${id}`, async () => {
      const { data } = await json(`https://api.artic.edu/api/v1/artworks/${id}?fields=id,title,image_id,artist_title,date_display,is_public_domain,short_description`);
      if (!data.is_public_domain || !data.image_id) throw new Error("not public domain");
      const file = path.join(cache, "art", `${safe(data.title.split(" (")[0].split(",")[0])}.jpg`);
      await fetchTo(`https://www.artic.edu/iiif/2/${data.image_id}/full/1686,/0/default.jpg`, file).catch(() =>
        fetchTo(`https://www.artic.edu/iiif/2/${data.image_id}/full/843,/0/default.jpg`, file));
      return { file, folder, tags, title: data.title.split(" (")[0], creator: data.artist_title, created: data.date_display, description: data.short_description || "", rights: "CC0 · Art Institute of Chicago", ...extra };
    });
  log("Space");
  for (const [id, title, tags, extra = {}] of SPACE)
    await tryAdd(`nasa ${id}`, async () => {
      const assets = (await json(`https://images-api.nasa.gov/asset/${encodeURIComponent(id)}`)).collection.items.map((i) => i.href);
      const pick = assets.find((h) => /~large\.jpg$/i.test(h)) || assets.find((h) => /~medium\.jpg$/i.test(h)) || assets.find((h) => /~orig\.jpg$/i.test(h));
      if (!pick) throw new Error("no image");
      const meta = (await json(`https://images-api.nasa.gov/search?nasa_id=${encodeURIComponent(id)}`)).collection.items[0]?.data[0] || {};
      const file = path.join(cache, "space", `${safe(title)}.jpg`);
      await fetchTo(pick.replace(/^http:/, "https:"), file);
      return { file, folder: "Space", tags, title, creator: meta.photographer || meta.center || "NASA", created: (meta.date_created || "").slice(0, 10), description: (meta.description || "").replace(/<[^>]+>/g, "").slice(0, 600), rights: "Public domain · NASA", ...extra };
    });
  log("Music");
  for (const [name, folder, title, creator, tags, extra = {}] of MUSIC)
    await tryAdd(name, async () => {
      const pages = (await json(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&titles=${encodeURIComponent(name)}`)).query.pages;
      const info = Object.values(pages)[0]?.imageinfo?.[0];
      if (!info) throw new Error("not found");
      const license = info.extmetadata?.LicenseShortName?.value || "See source";
      const file = path.join(cache, "music", `${safe(title)}${path.extname(name)}`);
      await fetchTo(info.url, file);
      return { file, folder, tags, title, creator, rights: `${license} · Wikimedia Commons`, ...extra };
    });
  log("Books");
  for (const [id, title, creator, created, extra = {}] of BOOKS)
    await tryAdd(title, async () => {
      const file = path.join(cache, "books", `${safe(title)}.epub`);
      await fetchTo(`https://www.gutenberg.org/ebooks/${id}.epub3.images`, file, (body) => body.subarray(0, 2).toString() === "PK");
      return { file, folder: "Classics", tags: ["reading", "classics"], title, creator, created, rights: "Public domain · Project Gutenberg", ...extra };
    });
  log("Films and documents");
  for (const [url, folder, title, creator, created, tags, extra = {}] of FILES)
    await tryAdd(title, async () => {
      const file = path.join(cache, "files", `${safe(title)}${path.extname(new URL(url).pathname)}`);
      await fetchTo(url, file);
      return { file, folder, tags, title, creator, created, rights: creator === "NASA" ? "Public domain · NASA" : "CC BY 3.0 · Blender Foundation", ...extra };
    });
  for (const [name, text, tags, extra = {}] of NOTES) {
    const file = path.join(cache, "notes", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    out.push({ file, folder: "Notes", tags, title: name.replace(/\.[a-z]+$/, ""), ...extra });
  }
  // Interleaved, so the newest-first view mixes kinds of files.
  const groups = Object.values(Object.groupBy(out, (entry) => path.basename(path.dirname(entry.file))));
  const mixed = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const g of groups) if (g[i]) mixed.push(g[i]);
  return mixed.reverse();
}

/** Folders, local files and their details, through the same core the app uses. */
async function build(files) {
  const opened = await openLibrary(library);
  try {
    const folderId = new Map();
    const find = (name, parent) => opened.state().folders.find((f) => f.name === name && (f.parent || null) === (parent || null));
    for (const [where, icon] of FOLDERS) {
      let parent = null;
      for (const name of where.split("/")) {
        const found = find(name, parent) || (await opened.folders.create(parent, name, name === where.split("/").pop() ? icon : "folder"));
        parent = found.id;
        folderId.set(name, found.id);
      }
    }
    for (const name of ["Space", "Art", "Piano", "Strings", "Classics", "NASA", "Notes", "Blender films"])
      if (!folderId.has(name)) throw new Error(`Missing folder ${name}`);
    const have = new Set(opened.state().items.map((i) => i.title));
    for (const entry of files) {
      if (have.has(entry.title)) continue;
      const [preview] = await opened.previewPaths([entry.file]);
      const [result] = await opened.importEntries([{ ...preview, folderId: folderId.get(entry.folder) }]);
      const id = result.item.id;
      const details = Object.fromEntries(
        ["title", "description", "favorite", "rating", "creator", "created", "rights"].filter((k) => entry[k] !== undefined && entry[k] !== "").map((k) => [k, entry[k]]),
      );
      await opened.updateMetadata(id, details);
      if (entry.tags?.length) await opened.updateTags([id], entry.tags, "add");
    }
    // Defaults this library doesn't use.
    for (const name of ["Other", "Audiobooks", "Photos"]) {
      const folder = opened.state().folders.find((f) => f.name === name);
      if (folder && !opened.state().items.some((i) => i.folderId === folder.id)) await opened.folders.remove(folder.id, { keep: true, trash: async (p) => rm(p, { recursive: true, force: true }) });
    }
    log(`Library has ${opened.state().items.length} files.`);
  } finally {
    await opened.close();
  }
}

/** Downloads that belong to the app's own importers, made in the app itself. */
async function downloads() {
  // The next normal launch opens the library. The builder runs with its own app
  // folder, so it works while another copy of Obelisk is open.
  const settings = JSON.stringify({ archiveRoot: library, onboarded: true }, null, 2);
  const builder = path.join(home, ".builder");
  await mkdir(builder, { recursive: true });
  await writeFile(path.join(home, "desktop-settings.json"), settings);
  await writeFile(path.join(builder, "desktop-settings.json"), settings);
  const env = { ...process.env, OBELISK_HOME: builder };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  try {
    await page.waitForFunction(() => window.obelisk?.state);
    const state = () => page.evaluate(() => window.obelisk.state());
    // Transfers stopped by an earlier run carry on; ones redone since are left.
    const all = (await state()).jobs || [];
    for (const job of all.filter((j) => j.status === "paused"))
      if (!all.some((other) => other !== job && other.status === "complete" && other.title === job.title))
        await page.evaluate((id) => window.obelisk.transfer(id, "resume"), job.id).catch(() => {});
    // Sites can redirect, so what was asked for is read from the transfers.
    const asked = new Set(((await state()).jobs || []).map((j) => j.url));
    const queued = [];
    for (const [url] of SITES)
      if (!asked.has(url)) queued.push(page.evaluate((url) => window.obelisk.savePage({ url }), url).catch((e) => log(`  ✗ ${url}: ${e.message}`)));
    for (const [title, bbox, zoom] of MAPS)
      if (!(await state()).items.some((i) => i.source?.adapter === "maps" && i.title.startsWith(title)))
        queued.push(page.evaluate(([title, bbox, zoom]) => window.obelisk.source("acquireMap", { title, bbox, zoom }), [title, bbox, zoom]).catch((e) => log(`  ✗ map ${title}: ${e.message}`)));
    if (!(await state()).items.some((i) => i.source?.adapter === "podcasts")) {
      const found = await page.evaluate((q) => window.obelisk.source("podcastSearch", { query: q }), PODCAST.query);
      const show = (found.results || found.shows || found)[0];
      if (show?.feedUrl) {
        const feed = await page.evaluate((url) => window.obelisk.source("podcastFeed", { url }), show.feedUrl);
        const recent = feed.episodes.slice(0, 8).sort((a, b) => (a.bytes || a.length || 9e9) - (b.bytes || b.length || 9e9));
        for (const episode of recent.slice(0, PODCAST.episodes))
          queued.push(page.evaluate((key) => window.obelisk.source("acquire", { key }), episode.key));
      } else log("  ✗ podcast: no show found");
    }
    if (!(await state()).items.some((i) => i.source?.adapter === "wikipedia"))
      for (const query of WIKIPEDIA) {
        const listed = await page.evaluate((query) => window.obelisk.source("wikipedia", { language: "eng", query }), query);
        const small = listed.entries.filter((e) => e.bytes && e.bytes < 60e6).sort((a, b) => a.bytes - b.bytes)[0];
        if (small) queued.push(page.evaluate((key) => window.obelisk.source("acquire", { key }), small.key));
        else log(`  ✗ wikipedia ${query}: nothing small enough`);
      }
    await Promise.all(queued);
    log(`Waiting for ${queued.length} transfers…`);
    for (let waited = 0; waited < 20 * 60; waited += 3) {
      const jobs = (await state()).jobs || [];
      const open = jobs.filter((j) => !["complete", "failed", "paused"].includes(j.status));
      if (!open.length) {
        for (const j of jobs.filter((j) => j.status === "failed")) log(`  ✗ ${j.title}: ${j.error}`);
        break;
      }
      await page.waitForTimeout(3000);
    }
    // Details for what the importers saved.
    const items = (await state()).items;
    const tag = async (match, tags, details = {}) => {
      const item = items.find(match);
      if (!item) return;
      if (Object.keys(details).length) await page.evaluate(([id, d]) => window.obelisk.updateMetadata(id, d), [item.id, details]);
      await page.evaluate(([id, t]) => window.obelisk.updateTags([id], t, "add"), [item.id, tags]);
    };
    const jobs = (await state()).jobs || [];
    for (const [url, title, tags] of SITES) {
      const job = jobs.find((j) => j.url === url && j.itemId);
      if (job) await tag((i) => i.id === job.itemId, tags, { title });
    }
    const map = (name) => (i) => i.source?.adapter === "maps" && i.title.startsWith(name);
    await tag(map("Kyoto"), ["japan", "travel"], { favorite: true });
    await tag(map("Lisbon"), ["travel"]);
    log(`Done: ${items.length} files in ${library}`);
  } finally {
    await app.close();
  }
}

// A rebuild sends the old library to the Trash rather than deleting it.
if (process.argv.includes("--fresh") && (await exists(library))) await run("trash", [library]);
log("Gathering files (cached in demo/.cache)…");
const files = await gather();
await build([]);
await downloads();
await build(files);
const total = await stat(library).then(() => true, () => false);
if (!total) process.exitCode = 1;
