// Drives the real desktop app through its main flows in a throwaway home folder,
// so it never touches the demo archive and can run while another copy is open.
//   node scripts/smoke.js
import {testCollectionBrowsing} from "./collection-browsing-smoke.js";
import {testReader} from "./reader-smoke.js";
import {_electron as electron} from "playwright-core";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  rename,
  access,
} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = await mkdtemp(path.join(os.tmpdir(), "obelisk-smoke-"));
const input = path.join(home, "to-import", "Trip");
await mkdir(input, {recursive: true});
// One second of a quiet tone, as a real WAV file.
const samples = 8000,
  wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++)
  wav.writeInt16LE(Math.round(Math.sin(i / 6) * 8000), 44 + i * 2);
await writeFile(path.join(input, "tone.wav"), wav);
await writeFile(path.join(input, "notes.txt"), `Field notes ${Date.now()}`);
await writeFile(path.join(input, "skip-me.txt"), `Not wanted ${Date.now()}`);

// A small site to save, and a download that sends a little and then hangs.
let podcastRequests = 0;
const server = http.createServer((req, res) => {
  if (
    ["/podcast.xml", "/short-podcast.xml", "/empty-podcast.xml"].includes(
      req.url,
    )
  ) {
    podcastRequests++;
    const count =
      req.url === "/podcast.xml"
        ? 205
        : req.url === "/short-podcast.xml"
          ? 100
          : 0;
    const episodes = Array.from(
      {length: count},
      (_, i) =>
        `<item><title>Episode ${String(i + 1).padStart(3, "0")}</title><guid>episode-${i}</guid><pubDate>${new Date(Date.UTC(2026, 0, 1) - i * 86400000).toUTCString()}</pubDate><description>Recorded history for the pagination test.</description><enclosure url="http://${req.headers.host}/episode.wav" type="audio/wav"/></item>`,
    ).join("");
    res.writeHead(200, {"content-type": "application/rss+xml"});
    return res.end(
      `<rss><channel><title>Pagination test show</title>${episodes}</channel></rss>`,
    );
  }
  if (req.url === "/page/") {
    res.writeHead(200, {"content-type": "text/html"});
    return res.end(
      '<title>Smoke test page</title><link rel="stylesheet" href="s.css"><h1>Saved</h1>',
    );
  }
  if (req.url === "/page/s.css") {
    res.writeHead(200, {"content-type": "text/css"});
    return res.end("h1{color:rgb(10, 20, 30)}");
  }
  if (req.url === "/stall.bin") {
    res.writeHead(200, {"content-length": "50000000"});
    return res.write(Buffer.alloc(100000));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const env = {...process.env, OBELISK_HOME: home};
delete env.ELECTRON_RUN_AS_NODE;
let app = await electron.launch({args: [root], env});
let page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const state = () => page.evaluate(() => window.obelisk.state());
const step = (name) => console.log(`✓ ${name}`);
try {
  // First launch: setup creates the library. A folder that already holds other
  // files is never taken over (on a case-insensitive disk "Obelisk" may be an
  // existing "obelisk" folder).
  await page
    .locator("#onboarding h1", {hasText: "Welcome to Obelisk"})
    .waitFor();
  await page.getByRole("button", {name: "Set up my library"}).click();
  const drive = path.join(home, "Drive");
  await mkdir(path.join(drive, "obelisk"), {recursive: true});
  await writeFile(
    path.join(drive, "obelisk", "someone-else.txt"),
    "not a library",
  );
  await app.evaluate(({dialog}, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, drive);
  await page.locator(".drive").first().waitFor();
  await page.getByRole("button", {name: "Change…"}).click();
  await page
    .locator(".onboarding-path", {hasText: path.join(drive, "Obelisk")})
    .waitFor();
  await page.getByRole("button", {name: "Create library"}).click();
  await page
    .locator(".onboarding-error", {hasText: "already has other files"})
    .waitFor();
  await page.getByLabel("Folder name").fill("My library");
  await page.getByRole("button", {name: "Create library"}).click();
  await page
    .locator("#onboarding h1", {hasText: "How Obelisk works"})
    .waitFor();
  await page.getByRole("button", {name: "Next"}).click();
  await page
    .locator("#onboarding h1", {hasText: "Save your first thing"})
    .waitFor();
  await page.getByRole("button", {name: "Open my library"}).click();
  await page.locator("#onboarding").waitFor({state: "hidden"});
  const fresh = await state();
  assert.equal(
    fresh.archiveRoot,
    await realpath(path.join(drive, "My library")),
  );
  assert.equal(fresh.items.length, 0);
  assert.equal(fresh.firstRun, false);
  assert.equal(fresh.untracked, 0);
  step(
    "first launch sets up a library, refusing a folder that has other files",
  );

  await testCollectionBrowsing(page);
  step("internal sections show up to 12 random collections, with See all beyond 12 and featured picks only at home");

  // Historical choices show the day, so a particular event isn't just a month.
  await page.locator(".primary-nav [data-view=discover]").click();
  await page.locator('#discover-home [data-type="web"]').click();
  await page.locator("#type-collections .collection-card").filter({hasText: "The early web"}).click();
  await page.locator("#collections-view h1", {hasText: "The early web"}).waitFor();
  assert.equal(await page.locator(".collection-entry").count(), 50);
  assert.equal(await page.locator(".collection-entry input[type=checkbox]").count(), 68);
  const mozilla = page.locator(".collection-entry").filter({hasText: "Mozilla"});
  assert.equal(await mozilla.locator(".entry-date span").last().innerText(), "Nov 9, 2004");
  assert.equal(await page.locator(".entry-date").filter({hasText: "Today"}).count(), 2);
  const saveCollection = page.locator(".collection-actions .primary");
  assert.equal(await saveCollection.innerText(), "Save all");
  await page.locator(".collection-entry input[type=checkbox]").first().uncheck();
  assert.equal(await saveCollection.innerText(), "Save 67");
  assert.equal((await state()).items.length, 0, "browsing historical pages doesn't save them");
  await page.locator(".collection-back").click();
  await page.locator("#back-discover").click();
  step("early-web pages show exact capture days and keep date selections distinct");

  // The shipped recommendations appear with their reasons, without saving episodes.
  const shows = JSON.parse(
    await readFile(
      path.join(root, "collections/podcasts/podcasts.json"),
      "utf8",
    ),
  ).entries;
  await page.locator(".primary-nav [data-view=discover]").click();
  await page.locator('#discover-home [data-type="podcasts"]').click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".show-card").length === count,
    shows.length,
  );
  assert.deepEqual(
    await page.locator(".show-card strong").allTextContents(),
    shows.map((show) => show.title),
  );
  assert.deepEqual(
    await page.locator(".show-card .muted").allTextContents(),
    shows.map((show) => show.note),
  );
  assert.equal(
    (await state()).items.length,
    0,
    "recommendations do not download episodes",
  );
  step(
    "podcast recommendations display every show and its reason without downloading",
  );

  // Pages use the complete local feed and keep selections while moving both ways.
  await page.locator("#show-rss").click();
  const openPodcast = async (route) => {
    await page.getByLabel("Podcast RSS URL").fill(`${base}${route}`);
    await page
      .locator('#rss-form button[type="submit"], #rss-form button')
      .click();
    await page.locator("#episode-panel").waitFor({state: "visible"});
  };
  await openPodcast("/podcast.xml");
  assert.equal(await page.locator(".episode-row").count(), 100);
  assert.equal(
    await page.locator("#episodes-top [role=status]").innerText(),
    "1–100 of 205",
  );
  assert.ok(
    await page
      .locator("#episodes-top")
      .getByRole("button", {name: "View newer"})
      .isDisabled(),
  );
  await page.getByLabel("Select Episode 001", {exact: true}).check();
  await page
    .locator("#episodes-bottom")
    .getByRole("button", {name: "View older"})
    .click();
  assert.equal(
    await page.locator(".episode-row h3").first().innerText(),
    "Episode 101",
  );
  assert.equal(await page.locator(".episode-row").count(), 100);
  await page
    .locator("#episodes-top")
    .getByRole("button", {name: "View older"})
    .click();
  assert.equal(await page.locator(".episode-row").count(), 5);
  assert.equal(
    await page.locator("#episodes-bottom [role=status]").innerText(),
    "201–205 of 205",
  );
  assert.ok(
    await page
      .locator("#episodes-bottom")
      .getByRole("button", {name: "View older"})
      .isDisabled(),
  );
  await page.getByLabel("Select Episode 201", {exact: true}).check();
  assert.equal(
    await page.locator("#download-selected").innerText(),
    "Download 2 episodes",
  );
  await page.locator("#select-episodes").check();
  assert.equal(
    await page.locator("#download-selected").innerText(),
    "Download 6 episodes",
  );
  await page.locator("#select-episodes").uncheck();
  assert.equal(
    await page.locator("#download-selected").innerText(),
    "Download 1 episode",
  );
  await page
    .locator("#episodes-bottom")
    .getByRole("button", {name: "View newer"})
    .click();
  await page
    .locator("#episodes-top")
    .getByRole("button", {name: "View newer"})
    .click();
  assert.ok(
    await page.getByLabel("Select Episode 001", {exact: true}).isChecked(),
  );
  assert.equal(
    podcastRequests,
    1,
    "changing pages does not fetch the feed again",
  );
  await openPodcast("/short-podcast.xml");
  assert.equal(await page.locator(".episode-row").count(), 100);
  assert.ok(await page.locator("#episodes-top").isHidden());
  assert.ok(await page.locator("#episodes-bottom").isHidden());
  assert.ok(
    await page.locator("#download-selected").isDisabled(),
    "a new feed clears selection",
  );
  await openPodcast("/empty-podcast.xml");
  assert.equal(await page.locator(".episode-row").count(), 0);
  assert.match(await page.locator("#episodes").innerText(), /no downloadable/);
  assert.ok(await page.locator("#episodes-top").isHidden());
  step(
    "podcasts page by 100 past episode 200, preserve selections, and hide paging for short or empty feeds",
  );
  await page.locator("#back-discover").click();

  // Adding files: listed for review first, nothing copied until confirmed.
  await app.evaluate(({dialog}, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
    dialog.showMessageBox = async () => ({response: 0});
  }, input);
  await page.locator(".primary-nav [data-view=discover]").click();
  await page.locator("#import-folder").click();
  await page.locator("#review-dialog[open]").waitFor();
  assert.equal(await page.locator(".review-row").count(), 3);
  assert.ok(
    !(await state()).items.some((i) => i.filename === "tone.wav"),
    "nothing is imported before confirming",
  );
  await page.locator("#review-tags").fill("smoke, trip");
  await page.locator("#review-tag-all").click();
  const titles = await page
    .locator(".review-top > input")
    .evaluateAll((inputs) => inputs.map((i) => i.value));
  await page
    .locator(".review-row")
    .nth(titles.indexOf("skip-me"))
    .locator(".review-remove")
    .click();
  assert.equal(await page.locator("#review-save").innerText(), "Add 2 files");
  await page.locator("#review-save").click();
  await page.waitForFunction(() =>
    window.obelisk
      .state()
      .then(
        (s) => s.items.filter((i) => i.tags?.includes("smoke")).length === 2,
      ),
  );
  assert.ok(
    !(await state()).items.some((i) => i.title === "skip-me"),
    "a removed file is not imported",
  );
  const imported = (await state()).items.filter((i) =>
    i.tags?.includes("smoke"),
  );
  assert.deepEqual(imported.map((i) => i.title).sort(), ["notes", "tone"]);
  assert.ok(imported.every((i) => i.source.folder === "Trip"));
  step("imports a folder after review, with tags, leaving out a removed file");

  // Tabs return to their front page.
  await page.locator(".primary-nav [data-view=library]").click();
  await page.locator(".file-card").first().dispatchEvent("dblclick");
  await page.locator("#viewer:not([hidden])").waitFor();
  await page.locator(".primary-nav [data-view=library]").click();
  assert.ok(await page.locator("#viewer").isHidden());
  step("Library tab closes an open file");

  // Filters.
  if (await page.locator("#filter-bar").isHidden())
    await page.locator("#toggle-filters").click();
  await page.locator("#type-filter").selectOption("audio");
  assert.ok((await page.locator(".file-card").count()) >= 1);
  await page.locator("#favorite-filter").click();
  const favorites = (await state()).items.filter(
    (i) => i.favorite && i.type === "audio",
  ).length;
  assert.equal(await page.locator(".file-card").count(), favorites);
  await page.locator("#favorite-filter").click();
  await page.locator("#type-filter").selectOption("");
  step("filters by type and favorites");

  // Settings and the integrity check.
  await page.locator("#archive-picker").click();
  await page.locator("#scan-archive").click();
  await page.waitForFunction(
    () => document.querySelector("#scan-archive").textContent === "Check files",
  );
  assert.ok(await page.locator("#archive-disk .disk-bar").isVisible());
  step("library details show disk space and check files");

  // Folders: make one, drag a file onto it, rename it from its header, delete it
  // while keeping what is inside.
  await page.locator(".primary-nav [data-view=library]").click();
  await page
    .locator("#folder-tree .folder-row", {hasText: "Audio"})
    .locator(".folder-main")
    .click();
  await page.locator("#new-subfolder").click();
  await page.locator(".folder-dialog input").fill("Smoke album");
  await page.locator(".icon-choice[aria-label=album]").click();
  await page.getByRole("button", {name: "Create folder"}).click();
  // Clicking a collapsed parent reveals its sidebar contents as well.
  const audioRow = page.locator('#folder-tree .folder-row', {hasText: 'Audio'}).first();
  if (await audioRow.locator('.folder-twisty.open').count())
    await audioRow.locator('.folder-twisty').click();
  assert.equal(await page.locator('#folder-tree .folder-row', {hasText: 'Smoke album'}).count(), 0);
  await audioRow.locator('.folder-main').click();
  await page.locator('#folder-tree .folder-row', {hasText: 'Smoke album'}).waitFor();
  const album = page.locator(".folder-tile", {hasText: "Smoke album"});
  await album.waitFor();
  const subfolders = page.locator('#include-subfolders');
  for (const checked of [true, false]) {
    await subfolders.setChecked(checked);
    await page.waitForFunction(checked => {
      const input = document.querySelector('#include-subfolders');
      const track = input.getBoundingClientRect();
      const style = getComputedStyle(input, '::after');
      const move = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
      const x = parseFloat(style.left) + move.e;
      const y = parseFloat(style.top) + move.f;
      const side = checked ? track.width - x - parseFloat(style.width) : x;
      return Math.abs(y + parseFloat(style.height) / 2 - track.height / 2) < 0.1 && Math.abs(side - 3) < 0.1;
    }, checked);
    await page.locator('#files-bar').screenshot({path: `/private/tmp/obelisk-subfolders-${checked ? 'on' : 'off'}.png`});
  }
  const tone = (await state()).items.find((i) => i.title === "tone");
  await page.locator(`.file-card[data-id="${tone.id}"]`).dragTo(album);
  const albumId = (await state()).folders.find(
    (f) => f.name === "Smoke album",
  ).id;
  await page.waitForFunction(
    ([id, folder]) =>
      window.obelisk
        .state()
        .then((s) => s.items.find((i) => i.id === id)?.folderId === folder),
    [tone.id, albumId],
  );
  await album.click();
  await page.locator("#library-heading").dblclick();
  await page.locator(".folder-dialog input").fill("Smoke album: renamed");
  await page.getByRole("button", {name: "Save"}).click();
  await page.waitForFunction(() =>
    window.obelisk
      .state()
      .then((s) =>
        s.folders.some(
          (f) =>
            f.name === "Smoke album: renamed" &&
            f.dir.endsWith("Smoke album- renamed"),
        ),
      ),
  );
  // In the sidebar: dropped on a row's edge it goes beside that row (here, the top
  // level); dropped on the middle it goes inside.
  const row = (name) =>
    page.locator("#folder-tree .folder-row", {hasText: name}).first();
  const parentOf = () =>
    window.obelisk
      .state()
      .then(
        (s) =>
          s.folders.find(
            (f) =>
              f.id ===
              s.folders.find((x) => x.name === "Smoke album: renamed").parent,
          )?.name || null,
      );
  await row("Smoke album").dragTo(row("Documents"), {
    targetPosition: {x: 60, y: 2},
  });
  await page.waitForFunction(
    (check) => eval(check)().then((p) => p === null),
    parentOf.toString(),
  );
  await row("Smoke album").dragTo(row("Audio"));
  await page.waitForFunction(
    (check) => eval(check)().then((p) => p === "Audio"),
    parentOf.toString(),
  );
  await page.locator("#folder-actions").click();
  await page.locator("#context-menu button", {hasText: "Delete"}).click();
  await page.locator(".folder-dialog[open]").waitFor();
  await page.getByRole("button", {name: /Keep the contents/}).click();
  await page.waitForFunction(
    (id) =>
      window.obelisk
        .state()
        .then(
          (s) =>
            !s.folders.some((f) => f.name.startsWith("Smoke album")) &&
            s.items.find((i) => i.id === id)?.folderId ===
              s.folders.find((f) => f.name === "Audio")?.id,
        ),
    tone.id,
  );
  step(
    "creates, fills, renames, drags and deletes a folder without losing files",
  );
  await page.locator("#archive-picker").click();

  // A file put straight into the archive folder is found and added where it is.
  const {archiveRoot} = await state();
  await mkdir(path.join(archiveRoot, "Images"), {recursive: true});
  await writeFile(
    path.join(archiveRoot, "Images", "stray-smoke.txt"),
    `Stray ${Date.now()}`,
  );
  await page.locator("#scan-archive").click();
  await page
    .locator("#archive-untracked", {hasText: "1 file isn’t in the library yet"})
    .waitFor();
  assert.equal(await page.locator("#health-count").innerText(), "1");
  await page.locator("#archive-untracked button").click();
  await page.locator("#review-dialog[open]").waitFor();
  assert.equal(await page.locator(".review-row").count(), 1);
  await page.locator("#review-save").click();
  await page.locator("#archive-untracked").waitFor({state: "hidden"});
  assert.ok((await state()).items.some((i) => i.title === "stray-smoke"));
  step("adds a file found in the archive folder");

  // Transfers: a stalled download can be cancelled and stays gone.
  await page.evaluate(
    (url) => window.obelisk.download({url, title: "Stalled"}),
    `${base}/stall.bin`,
  );
  await page.locator(".primary-nav [data-view=transfers]").click();
  const stalled = page.locator(".job").filter({hasText: "Stalled"});
  await stalled.getByRole("button", {name: "Cancel"}).click();
  await page.waitForTimeout(2000);
  assert.equal(
    (await state()).jobs.filter((j) => j.title === "Stalled").length,
    0,
  );
  step("cancels a stalled download");

  // Web pages: save, then reopen offline.
  const before = new Set((await state()).items.map((i) => i.id));
  await page.evaluate((url) => window.obelisk.savePage({url}), `${base}/page/`);
  let saved;
  for (let i = 0; i < 60 && !saved; i++) {
    await page.waitForTimeout(500);
    saved = (await state()).items.find(
      (x) => x.media === "web" && !before.has(x.id),
    );
  }
  assert.equal(saved?.title, "Smoke test page");
  // It opens inside the viewer, lined up with the stage under the toolbar.
  await page.locator(".primary-nav [data-view=library]").click();
  await page.locator(`.file-card[data-id="${saved.id}"]`).dblclick();
  await page
    .locator(".saved-bar .saved-badge", {hasText: "Saved copy"})
    .waitFor();
  const pageView = () =>
    app.evaluate(({BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.contentView.children.length,
      );
      const view = win?.contentView.children.find((v) =>
        /^http/.test(v.webContents?.getURL()),
      );
      return view ? {...view.getBounds(), visible: view.getVisible()} : null;
    });
  const stage = await page.locator(".saved-stage").boundingBox();
  await page.waitForTimeout(300);
  const placed = await pageView();
  assert.ok(
    placed?.visible &&
      Math.abs(placed.y - stage.y) <= 1 &&
      Math.abs(placed.width - stage.width) <= 1,
    "page sits on the stage",
  );
  const replay = await app.evaluate(async ({webContents}) => {
    const view = webContents
      .getAllWebContents()
      .find((w) => /^http/.test(w.getURL()));
    return view.executeJavaScript(
      'getComputedStyle(document.querySelector("h1")).color',
    );
  });
  assert.equal(replay, "rgb(10, 20, 30)");
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  assert.equal(
    (await pageView()).visible,
    false,
    "page steps aside for dialogs",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(await pageView(), null, "closing the viewer closes the page");
  step("saves a web page and replays it from the file");

  await testReader(app, page, home);
  step("EPUB bookmarks, EPUB 2/3 chapter labels, encoded footnotes, keyboard navigation and text sizing");

  // Appearance switches without errors.
  await page.locator("[data-theme-choice=light]").click();
  await page.locator("[data-theme-choice=dark]").click();
  step("switches light and dark");

  // The guide.
  await page.locator("#show-shortcuts").click();
  await page
    .locator("#onboarding h1", {hasText: "How Obelisk works"})
    .waitFor();
  await page.getByRole("button", {name: "Done"}).click();
  step("shows the guide");

  // A library that has gone missing is asked about, never recreated empty.
  const made = (await state()).archiveRoot;
  await app.close();
  await rename(made, `${made} moved`);
  app = await electron.launch({args: [root], env});
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .locator("#onboarding h1", {hasText: "Your library isn’t there"})
    .waitFor();
  await assert.rejects(access(made), "the folder is not recreated");
  await rename(`${made} moved`, made);
  await page.waitForLoadState("load");
  await page.waitForTimeout(500); // the panel finishes sliding in
  await page.getByRole("button", {name: "Try again"}).click();
  await page.waitForFunction(
    (where) =>
      window.obelisk
        .state()
        .then((s) => s.archiveRoot === where && !s.missingLibrary),
    made,
  );
  step("asks about a missing library instead of recreating it");

  assert.deepEqual(errors, [], "no page errors");
  console.log("Smoke test passed.");
} catch (error) {
  console.error(`✗ ${error.message}`);
  if (errors.length) console.error(`Page errors:\n${errors.join("\n")}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await rm(home, {recursive: true, force: true});
}
