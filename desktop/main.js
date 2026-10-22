import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  shell,
  Menu,
  session,
  net,
} from "electron";
import path from "node:path";
import { thumbnailStore } from "./thumbnails.js";
import { audioPeaks } from "./waveform.js";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, stat, readdir, statfs, access, realpath } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import os from "node:os";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { seed } from "../scripts/seed.js";
import { openLibrary, upgradeLegacyLibrary } from "../packages/core/library.js";
import { inside, fileResponse } from "./files.js";
import { USER_AGENT } from "../packages/core/agent.js";
import {
  shelfOf,
  shelfExtensions,
  mediaOf,
} from "../packages/types/index.js";
import { softwareCatalog, softwarePlan } from "../packages/sources/software.js";
import { saveAppCopy } from "./self-backup.js";
import { cloudService } from "./cloud-folders.js";
import { createCollectionSource } from "../packages/collections/source.js";
import { createVideoTools, videoPlan } from "../packages/core/video-tools.js";
import { createZimReader } from "./zim/service.js";
import { createWebArchive, waybackProbe } from "./web-archive.js";
import {
  webPlan,
  waybackClosest,
  waybackSeries,
  pageUrl,
} from "../packages/sources/web.js";
// Node gives each of a server's addresses a quarter of a second to answer before trying
// the next; a distant server (CERN's, from here) needs longer, and then fails though it's fine.
setDefaultAutoSelectFamilyAttemptTimeout(2500);
const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const home = path.resolve(
  process.env.OBELISK_HOME ||
    (app.isPackaged ? app.getPath("userData") : path.join(project, "demo")),
);
const videoTools = createVideoTools(path.join(home, "tools", "video"));
const zimReader = createZimReader(() => library);
const webArchive = createWebArchive({ getLibrary: () => library });
// Collections: the list published from the repository, cached here, with the copy
// shipped in this release for first launch and offline use. The address is set in
// package.json ("obelisk.collections") once the repository is public.
const collections = createCollectionSource({
  bundled: path.join(project, "collections", "collections.json"),
  cacheFile: path.join(home, "collections-cache.json"),
  url: JSON.parse(readFileSync(path.join(project, "package.json"), "utf8")).obelisk?.collections || "",
  fetch: (url, init) => net.fetch(url, init),
});
// The window is told something changed; bursts (a download's progress, a big
// import) are gathered into one message every 150 ms at most.
let announcing = null;
function announce() {
  announcing ||= setTimeout(() => {
    announcing = null;
    if (window && !window.isDestroyed()) window.webContents.send("library:changed");
  }, 150);
}
const openDesktopLibrary = async (root, stateRoot) => {
  const opened = await openLibrary(root, stateRoot, {
    drivers: { video: videoTools.transfer, web: webArchive.transfer },
    fetch: (url, init) => net.fetch(url, init),
  });
  opened.onChange(announce);
  return opened;
};
await mkdir(path.join(home, ".electron"), { recursive: true });
app.setPath("userData", path.join(home, ".electron"));
app.setPath("sessionData", path.join(home, ".electron"));
app.setName("Obelisk");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "obelisk",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const ownsLock = app.requestSingleInstanceLock();
let window,
  library,
  closing = false,
  switching = false;
let appCopyPromise;
let appCopyError = null;
/**
 * Saves this app into the open library, once per version and system, in the background.
 * The demo lives in the app's own data, so it gets none.
 */
async function ensureAppCopy() {
  appCopyError = null;
  if (!app.isPackaged || library.archiveRoot === demoArchive) return;
  const saved = library
    .state()
    .items.find(
      (i) =>
        i.source?.adapter === "self-backup" &&
        i.source.version === app.getVersion() &&
        i.software?.platform === process.platform &&
        i.software?.arch === process.arch &&
        i.integrity !== "changed" &&
        !["missing", "ambiguous"].includes(i.fileState),
    );
  if (saved) {
    try {
      if ((await stat(await inside(library.archiveRoot, saved.path))).isFile())
        return;
    } catch {}
  }
  // Once nothing else is changing the library, which may be switched meanwhile.
  const target = library;
  while (target.busy()) await new Promise((resolve) => setTimeout(resolve, 2000));
  if (library !== target || closing) return;
  try {
    appCopyPromise = saveAppCopy(app, library, project);
    await appCopyPromise;
  } catch (e) {
    appCopyError = e.message;
  }
  announce();
}
let videoFullscreen = false,
  previousFullscreen = false;
const settingsFile = path.join(home, "desktop-settings.json");
const websiteHosts = new Set([
  "lmstudio.ai",
  "kiwix.org",
  "get.kiwix.org",
  "www.kiwix.org",
  "replayweb.page",
]);
function trusted(event) {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== "obelisk://app/index.html"
  )
    throw new Error("This action is only available in Obelisk.");
  if (switching) throw new Error("Wait for the archive to finish opening.");
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    return action(...args);
  });
}
// Remembered between launches: which library is open, and whether setup was finished.
let settings = {},
  // The chosen library's folder when it could not be found at launch.
  missingLibrary = null,
  // The demo's folder as the library reports it (symlinks such as /var resolved).
  demoArchive = null;
async function saveSettings(patch) {
  const next = { ...settings, ...patch };
  await writeFile(settingsFile, JSON.stringify(next, null, 2));
  settings = next;
}
/** Closes the open library and opens `chosen` in its place. */
async function useArchive(chosen) {
  if (library.busy())
    throw new Error(
      "Pause active transfers and wait for imports to finish before switching archives.",
    );
  if (chosen === library.archiveRoot) {
    await saveSettings({ archiveRoot: chosen, onboarded: true });
    return library.state();
  }
  switching = true;
  try {
    const next = await openDesktopLibrary(
      chosen,
      chosen === path.join(home, "archive") ? home : undefined,
    );
    try {
      await saveSettings({ archiveRoot: next.archiveRoot, onboarded: true });
      missingLibrary = null;
    } catch (e) {
      await next.close();
      throw e;
    }
    zimReader.close();
    webArchive.closeInline();
    // A copy still being saved into the old library finishes first.
    await Promise.resolve(appCopyPromise).catch(() => {});
    await library.close();
    library = next;
    void ensureAppCopy();
    return library.state();
  } finally {
    switching = false;
  }
}
/** A folder that already holds an Obelisk library (its state folder or guide). */
async function isLibrary(folder) {
  await upgradeLegacyLibrary(folder).catch(() => {});
  for (const mark of [".obelisk", "ABOUT THIS ARCHIVE.txt"])
    try {
      await access(path.join(folder, mark));
      return true;
    } catch {}
  return false;
}
/** Whether a folder has anything in it besides system clutter. */
async function hasFiles(folder) {
  const names = await readdir(folder).catch(() => []);
  return names.some((n) => ![".DS_Store", ".localized", "Icon\r"].includes(n));
}
/** The library a folder sits inside, if any. */
async function libraryAbove(folder) {
  for (let at = path.dirname(folder); at !== path.dirname(at); at = path.dirname(at))
    if (await isLibrary(at)) return at;
  return null;
}
/**
 * Opens a folder as a library. An existing library opens as it is. With `empty`, an
 * empty folder becomes a new library. Any other folder is refused: making a folder of
 * unrelated files into a library would list every one of them as not in the library.
 */
async function openArchive(folder, { empty = false } = {}) {
  folder = await realpath(folder);
  if (!(await isLibrary(folder))) {
    if (!empty) throw new Error("This folder isn’t an Obelisk library.");
    if (await hasFiles(folder))
      throw new Error(`“${path.basename(folder)}” already has other files in it. Choose an empty folder, or a different name or location.`);
    const above = await libraryAbove(folder);
    if (above) throw new Error(`This is inside another library (${above}). Choose a location outside it.`);
  }
  return useArchive(folder);
}
/**
 * Places a library could live: the home folder and every writable drive, with free
 * space, and whether an "Obelisk" library is already there.
 */
async function listDrives() {
  const places = [{ name: "This computer", path: os.homedir(), external: false }];
  const roots =
    process.platform === "darwin"
      ? ["/Volumes"]
      : process.platform === "win32"
        ? []
        : [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, "/mnt"];
  const system = await realpath("/").catch(() => "/");
  for (const root of roots)
    for (const name of await readdir(root).catch(() => [])) {
      if (name.startsWith(".")) continue;
      const folder = path.join(root, name);
      // The startup disk appears under /Volumes as a link to "/".
      if ((await realpath(folder).catch(() => system)) === system) continue;
      places.push({ name, path: folder, external: true });
    }
  if (process.platform === "win32")
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ")
      places.push({ name: `${letter}:`, path: `${letter}:\\`, external: true });
  const found = [];
  for (const place of places)
    try {
      await access(place.path, fsConstants.W_OK);
      const info = await statfs(place.path),
        suggested = path.join(place.path, "Obelisk");
      found.push({
        ...place,
        free: info.bavail * info.bsize,
        total: info.blocks * info.bsize,
        suggested,
        existing: await isLibrary(suggested),
      });
    } catch {}
  return found;
}
/** Makes (or reopens) a library at `folder`, which may not exist yet. */
async function createArchive(folder) {
  if (typeof folder !== "string" || !path.isAbsolute(folder))
    throw new Error("Choose a folder for the library.");
  const name = path.basename(folder);
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error("Choose a different name for the library.");
  // Names are not case-sensitive on most Macs and PCs: "Obelisk" may already exist
  // as "obelisk". It is only used if it is empty or already a library.
  let existed = true;
  try {
    await access(folder);
  } catch {
    existed = false;
  }
  if (!existed) {
    const above = await libraryAbove(folder);
    if (above) throw new Error(`This is inside another library (${above}). Choose a location outside it.`);
    await mkdir(folder, { recursive: true });
  }
  return openArchive(folder, { empty: true });
}
/** Asks which files to import. Returns their paths, or [] if cancelled. */
async function chooseImportPaths(options = {}) {
  const shelf = shelfOf(options.type),
    sub = shelf?.kinds.find((k) => k.id === options.kind),
    label = sub?.label || shelf?.label,
    extensions = shelf ? shelfExtensions(shelf.id) : [];
  const result = await dialog.showOpenDialog(window, {
    title: label ? `Add to ${label}` : "Add to library",
    message: label
      ? `Copies will be filed under ${label}. Original files stay in place.`
      : "Copies are filed by type. Original files stay in place.",
    // The shelf's usual formats come first, but anything may be filed there.
    ...(extensions.length
      ? {
          filters: [
            { name: label, extensions },
            { name: "All files", extensions: ["*"] },
          ],
        }
      : {}),
    buttonLabel: "Add",
    properties: [
      // Only macOS can offer files and folders in one picker.
      ...(options.folders
        ? ["openDirectory"]
        : process.platform === "darwin"
          ? ["openFile", "openDirectory"]
          : ["openFile"]),
      "multiSelections",
    ],
  });
  return result.canceled ? [] : result.filePaths;
}
async function importFiles(options = {}) {
  const paths = await chooseImportPaths(options);
  return paths.length ? library.importPaths(paths, options) : [];
}
/*
 * Importing is two steps. The files are listed first (nothing copied), the person
 * reviews and adjusts them, then confirms. The page only ever refers back to a
 * listing by token and position, never by path.
 */
const pendingImports = new Map();
async function listImport(paths, options = {}, found) {
  const listed = found || (await library.previewPaths(paths, options));
  if (!listed.length) return null;
  // Each file starts in a folder: where it already is, the folder the import was
  // started from, or where its kind of file usually goes.
  const state = library.state(),
    exists = (id) => state.folders.some((f) => f.id === id),
    chosen = typeof options.folderId === "string" && exists(options.folderId) ? options.folderId : null;
  const files = listed.map((file) => ({
    ...file,
    folderId: file.folderId || chosen || state.destinations[`files:${file.type}`] || state.inbox,
  }));
  const token = crypto.randomUUID();
  pendingImports.set(token, files);
  while (pendingImports.size > 20) pendingImports.delete(pendingImports.keys().next().value);
  return {
    token,
    files: files.map(({ name, relative, bytes, title, type, kind, folderId }, index) => ({ index, name, relative, bytes, title, type, kind, folderId })),
  };
}
const thumbnails = thumbnailStore(
  () => library,
  () => window,
);
function wireIPC() {
  handle("zim:open", (id) => zimReader.open(id));
  handle("zim:close", (token) => zimReader.close(token));
  const videos = new Map();
  handle("video:status", () => videoTools.status());
  handle("video:setup", () => videoTools.install());
  handle("video:inspect", async (url) => {
    const info = await videoTools.inspect(url);
    const key = crypto.randomUUID();
    if (videos.size >= 50) videos.delete(videos.keys().next().value);
    videos.set(key, info);
    return {
      key,
      title: info.title,
      creator: info.uploader || info.channel,
      duration: info.duration,
    };
  });
  handle("video:download", ({ key, quality }) => {
    const info = videos.get(key);
    if (!info) throw new Error("Check this video again before downloading.");
    return library.downloads.addPlan(videoPlan(info, quality));
  });
  handle("viewer:fullscreen", (enabled) => {
    if (enabled === true) {
      if (!videoFullscreen) previousFullscreen = window.isFullScreen();
      videoFullscreen = true;
      window.setFullScreen(true);
    } else if (videoFullscreen) {
      videoFullscreen = false;
      window.setFullScreen(previousFullscreen);
    }
    return videoFullscreen;
  });
  handle("library:state", (since) => ({
    ...library.state(typeof since === "string" ? since : undefined),
    softwareCatalog,
    appVersion: app.getVersion(),
    appCopyError,
    // First launch with nothing set up yet: the window shows setup first.
    firstRun: !settings.onboarded && !settings.archiveRoot,
    demo: library.archiveRoot === demoArchive,
    missingLibrary,
  }));
  handle("thumbnail:get", (id) => thumbnails.get(id));
  handle("thumbnail:save", (id, data) => thumbnails.save(id, data));
  handle("thumbnail:choose", (id) => thumbnails.choose(id));
  handle("library:metadata", (id, values) =>
    library.updateMetadata(id, values),
  );
  handle("thumbnail:waveform", async (id) => {
    const { item, filename } = await library.resolveItem(id);
    if (mediaOf(item.filename) !== "audio") return null;
    const saved = await thumbnails.peaks.get(id);
    if (saved) return saved;
    const heard = await audioPeaks(filename, path.join(home, "tools", "video"));
    return heard ? thumbnails.peaks.save(id, heard) : null;
  });
  handle("thumbnail:waveform-save", (id, value) =>
    thumbnails.peaks.save(id, value),
  );
  handle("library:tags", (ids, tags, mode) =>
    library.updateTags(ids, tags, mode),
  );
  handle("library:move", (ids, folderId) => library.moveItems(ids, folderId));
  handle("folders:create", (parentId, name, icon) => library.folders.create(parentId || null, name, icon));
  handle("folders:rename", (id, name) => library.folders.rename(id, name));
  handle("folders:icon", (id, icon) => library.folders.setIcon(id, icon));
  handle("folders:move", (id, parentId) => library.folders.move(id, parentId || null));
  handle("folders:order", (parentId, ids) => {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string")) throw new Error("Choose folders to order.");
    return library.folders.order(parentId || null, ids);
  });
  handle("folders:destination", (key, id) => library.folders.setDestination(key, id));
  handle("folders:reveal", async (id) => {
    const folder = library.state().folders.find((f) => f.id === id);
    if (!folder) throw new Error("This folder no longer exists.");
    shell.showItemInFolder(await inside(library.archiveRoot, folder.dir));
  });
  // Without `keep`, the folder and everything in it goes to the system Trash.
  handle("folders:remove", (id, keep) =>
    library.folders.remove(id, { keep: keep !== false, trash: (target) => shell.trashItem(target) }),
  );
  handle("library:tag-rename", (from, to) => library.renameTag(from, to));
  handle("library:trash", async (ids) => {
    if (!Array.isArray(ids) || !ids.length) return [];
    const one = ids.length === 1 && library.catalog.get(ids[0]);
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      message: one
        ? `Move “${one.title}” to the Trash?`
        : `Move ${ids.length} files to the Trash?`,
      detail: `You can put ${one ? "it" : "them"} back from the Trash.`,
      buttons: ["Move to Trash", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) return [];
    return library.removeItems(ids, (target) => shell.trashItem(target));
  });
  handle("library:check", () => library.check());
  handle("library:accept", (id) => library.accept(id));
  handle("software:notes", (id, notes) => library.saveSoftwareNotes(id, notes));
  handle("software:download", (id, platform, arch) =>
    library.downloads.addPlan(softwarePlan(id, platform, arch)),
  );
  handle("software:self", async () => {
    if (switching) throw new Error("An operation is in progress.");
    switching = true;
    try {
      await Promise.resolve(appCopyPromise).catch(() => {});
      appCopyPromise = saveAppCopy(app, library, project);
      return await appCopyPromise;
    } finally {
      switching = false;
    }
  });
  handle("setup:drives", listDrives);
  handle("setup:create", createArchive);
  handle("setup:cloud", async (folder) =>
    typeof folder === "string" ? cloudService(await realpath(folder).catch(() => folder)) : null,
  );
  handle("setup:open", (folder) => openArchive(folder));
  handle("setup:pick", async (purpose) => {
    const result = await dialog.showOpenDialog(window, {
      title: purpose === "open" ? "Choose your library folder" : "Choose where to keep the library",
      buttonLabel: purpose === "open" ? "Open library" : "Choose",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const folder = result.filePaths[0];
    return { path: folder, existing: await isLibrary(folder) };
  });
  // The missing library may be back (a drive plugged in); open it if so.
  handle("setup:retry", async () => {
    if (!missingLibrary) return null;
    if (!(await isLibrary(missingLibrary)))
      throw new Error("Still not there. Connect the drive or locate the folder.");
    return useArchive(missingLibrary);
  });
  // Exploring the demo also counts as having seen setup.
  handle("setup:finish", () => saveSettings({ onboarded: true }));
  handle("library:import", importFiles);
  handle("import:choose", async (options = {}) => {
    const paths = await chooseImportPaths(options);
    return paths.length ? listImport(paths, options) : null;
  });
  handle("import:drop", (paths, options = {}) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 200 || paths.some((p) => typeof p !== "string"))
      throw new Error("Drop up to 200 files.");
    return listImport(paths, options);
  });
  handle("import:commit", (token, entries) => {
    const files = pendingImports.get(token);
    if (!files || !Array.isArray(entries)) throw new Error("This import has expired. Choose the files again.");
    pendingImports.delete(token);
    const chosen = entries.map((entry) => {
      const file = files[entry?.index];
      if (!file) throw new Error("This import has expired. Choose the files again.");
      const shelf = shelfOf(entry.type) ? entry.type : file.type,
        kind = typeof entry.kind === "string" && shelfOf(shelf).kinds.some((k) => k.id === entry.kind) ? entry.kind : file.kind || "",
        title = String(entry.title || file.title).trim().slice(0, 200) || file.title,
        tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === "string").slice(0, 50) : [];
      const folderId = typeof entry.folderId === "string" ? entry.folderId : file.folderId;
      return { ...file, type: shelf, kind, title, tags, folderId };
    });
    return library.importEntries(chosen);
  });
  handle("import:cancel", (token) => void pendingImports.delete(token));
  // Files someone put straight into the archive folder; added where they are.
  handle("import:untracked", async () => {
    const paths = await library.untrackedPaths();
    if (!paths.length) return null;
    const files = await library.previewPaths(paths.slice(0, 1000), { limit: 1000 }),
      state = library.state();
    // Each file is added in the folder it was found in (at the top level: Inbox).
    return listImport(null, {}, files.map((file) => {
      const dir = path.relative(library.archiveRoot, path.dirname(file.file)).split(path.sep).join("/"),
        folder = state.folders.find((f) => f.dir === dir);
      return { ...file, inPlace: true, folderId: folder?.id || state.inbox };
    }));
  });
  handle("library:drop", async (paths, options = {}) => {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 200 ||
      paths.some((p) => typeof p !== "string")
    )
      throw new Error("Drop up to 200 files.");
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      message: `Add ${paths.length} file${paths.length === 1 ? "" : "s"}?`,
      detail: `Files will be copied into ${library.archiveRoot}. Originals are kept.`,
      buttons: ["Add", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    return answer.response === 0 ? library.importPaths(paths, options) : [];
  });
  handle("library:reveal", async (id) => {
    if (id === undefined) {
      const error = await shell.openPath(library.archiveRoot);
      if (error) throw new Error(error);
    } else shell.showItemInFolder((await library.resolveItem(id)).filename);
  });
  handle("library:text", (id) => library.readText(id));
  handle("library:open", async (id) => {
    const { filename, item } = await library.resolveItem(id);
    if (
      item.type === "software" ||
      /\.(exe|msi|pkg|dmg|app|appimage|sh|bat|cmd|ps1|js|html?|wacz)$/i.test(
        filename,
      )
    ) {
      shell.showItemInFolder(filename);
      return;
    }
    const error = await shell.openPath(filename);
    if (error) throw new Error(error);
  });
  handle("website:open", async (raw) => {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !websiteHosts.has(url.hostname))
      throw new Error("This website is not a preset source.");
    await shell.openExternal(url.href);
  });
  handle("download:add", (input) => library.downloads.add(input));
  // Collections. The window names a collection by ID; what's saved always comes from
  // the list here, never from the window.
  handle("collections:list", async () => {
    const { collections: list, featured, built } = await collections.load();
    // A newer list, if there is one, arrives in the background and the window is told.
    void collections.refresh().then((changed) => changed && announce());
    return { collections: list, featured, built, status: library.collections.status(list) };
  });
  const collectionNamed = async (id) => {
    const found = typeof id === "string" && (await collections.get(id));
    if (!found) throw new Error("That collection is no longer available.");
    return found;
  };
  handle("collections:save", async (id, keys) => {
    if (keys !== null && (!Array.isArray(keys) || keys.length > 2000 || keys.some((k) => typeof k !== "string")))
      throw new Error("Choose what to save.");
    const jobs = await library.collections.save(await collectionNamed(id), keys);
    return { queued: jobs.filter((j) => j.status !== "complete").length };
  });
  handle("collections:seen", async (id) => library.collections.seen(await collectionNamed(id)));
  handle("collections:group", async (id, action) => {
    if (typeof id !== "string" || !id.startsWith("collection:")) throw new Error("Unknown collection.");
    // Resuming follows the collection as it is now; a withdrawn one resumes as it was.
    const current = action === "resume" && (await collections.get(id.slice("collection:".length)));
    return current ? library.collections.resume(current) : library.downloads.group(id, action);
  });
  const wayback = { probe: waybackProbe };
  handle("web:wayback", (url, date) => waybackClosest(url, date, wayback));
  handle("web:wayback-series", (url, span = {}) =>
    waybackSeries(url, { from: span.from, to: span.to, every: span.every }, wayback),
  );
  handle("web:save", async (input = {}) => {
    let { url, timestamp } = input;
    // A pasted Wayback link means that recording, not today's page.
    if (!timestamp && pageUrl(url).timestamp)
      ({ url, timestamp } = await waybackClosest(url, "", wayback));
    return library.downloads.addPlan(webPlan({ url, timestamp }));
  });
  handle("web:open", (id) => webArchive.open(id));
  ipcMain.handle("web:embed", (event, id) => {
    trusted(event);
    return webArchive.embed(id, BrowserWindow.fromWebContents(event.sender));
  });
  handle("web:place", (token, bounds) => webArchive.placeInline(token, bounds));
  handle("web:command", (token, name) => webArchive.commandInline(token, name));
  handle("web:close", (token) => webArchive.closeInline(token));
  handle("web:info", (id) => webArchive.info(id));
  handle("web:thumbnail", (id) => webArchive.thumbnail(id));
  handle("download:action", (id, action) => {
    if (action === "clear") return library.downloads.clearFinished();
    if (!["pause", "resume", "cancel"].includes(action))
      throw new Error("Unknown transfer action.");
    return library.downloads[action](id);
  });
  handle("source:call", (operation, input = {}) => {
    switch (operation) {
      case "status":
        return library.sources.status();
      case "wikipedia":
        return library.sources.wikipedia(input);
      case "podcastSearch":
        return library.sources.search(
          input.query,
          input.provider || "apple",
          input.refresh,
        );
      case "podcastFeed":
        return library.sources.feed(input.url, input.refresh);
      case "podcastFollow":
        return library.sources.follow(input.feedUrl);
      case "maps":
        return library.sources.maps(input.refresh);
      case "acquire":
        return library.sources.acquire(input.key);
      case "places":
        return library.sources.places(input.query);
      case "mapSize":
        return library.sources.mapSize(input);
      case "acquireMap":
        return library.sources.acquireMap(input);
      default:
        throw new Error("Unknown source.");
    }
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1460,
    height: 960,
    minWidth: 1050,
    minHeight: 680,
    title: "Obelisk",
    icon: path.join(here, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: "#141218",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // Saved-page windows and unfinished captures belong to this window.
  window.on("closed", () => { webArchive.closeAll(); zimReader.close(); });
  // Coming back to the app is when files added in Finder are most likely; look then,
  // at most every few seconds (the look reads folders only, no file contents).
  let lookedAt = 0;
  window.on("focus", () => {
    if (Date.now() - lookedAt < 5000) return;
    lookedAt = Date.now();
    void library?.lookForUntracked();
  });
  window.on("leave-full-screen", () => {
    videoFullscreen = false;
    window.webContents.send("viewer:exit");
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== "obelisk://app/index.html") event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.url !== "about:srcdoc" && !event.url.startsWith("obelisk://")) event.preventDefault();
  });
  window.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame) {
      zimReader.close();
      webArchive.closeInline();
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  await window.loadURL("obelisk://app/index.html");
}
if (!ownsLock) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin")
        app.dock.setIcon(path.join(here, "assets/icon-macos.png"));
      try {
        settings = JSON.parse(await readFile(settingsFile, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT")
          console.error("Could not read archive preference:", e.message);
        // Installs from before the rename kept their settings under the old app name.
        else if (app.isPackaged && !process.env.OBELISK_HOME)
          try {
            const old = path.join(path.dirname(home), "Alexandria", "desktop-settings.json");
            settings = JSON.parse(await readFile(old, "utf8"));
            await saveSettings(settings);
          } catch {}
      }
      const defaultArchive = path.join(home, "archive");
      // A library that is not there (deleted, moved, or on a drive that is not
      // connected) is never recreated empty. The demo opens and the window asks.
      // A folder that no longer looks like a library (its marks removed) is treated
      // the same way, so an ordinary folder never quietly becomes one.
      if (
        settings.archiveRoot &&
        settings.archiveRoot !== defaultArchive &&
        !(await isLibrary(settings.archiveRoot))
      )
        missingLibrary = settings.archiveRoot;
      const opening = missingLibrary ? defaultArchive : settings.archiveRoot || defaultArchive;
      if (opening === defaultArchive) await seed(home);
      demoArchive = await realpath(defaultArchive).catch(() => defaultArchive);
      try {
        library = await openDesktopLibrary(opening, opening === defaultArchive ? home : undefined);
      } catch (e) {
        dialog.showErrorBox(
          "Cannot open archive",
          `${e.message}\nObelisk will open the demo. Your other archive has not been changed.`,
        );
        await seed(home);
        library = await openDesktopLibrary(defaultArchive, home);
      }
      protocol.handle("obelisk", async (request) => {
        try {
          if (!["GET", "HEAD"].includes(request.method))
            return new Response(null, { status: 405 });
          const url = new URL(request.url);
          if (url.hostname === "zim") return zimReader.response(request);
          if (url.hostname === "thumb") {
            const id = decodeURIComponent(url.pathname.slice(1)),
              cover = await thumbnails.file(id);
            // Formats the system cannot shrink are shown as they are.
            return fileResponse(request, cover || (await library.resolveItem(id)).filename, { cache: true });
          }
          if (url.hostname === "archive") {
            const { filename } = await library.resolveItem(
              decodeURIComponent(url.pathname.slice(1)),
            );
            return fileResponse(request, filename);
          }
          if (url.hostname !== "app")
            return new Response(null, { status: 404 });
          const relative = decodeURIComponent(
            url.pathname.slice(1) || "index.html",
          );
          const filename = relative.startsWith("map/")
            ? await inside(path.join(here, "map"), relative.slice(4))
            : await inside(path.join(here, "renderer"), relative);
          return fileResponse(request, filename, { trusted: true, zimReader: relative === "zim/index.html" });
        } catch {
          return new Response("File unavailable", { status: 404 });
        }
      });
      session.defaultSession.setPermissionRequestHandler(
        (wc, permission, callback, details) =>
          callback(
            permission === "fullscreen" &&
              wc === window?.webContents &&
              details.requestingUrl?.startsWith("obelisk://app/"),
          ),
      );
      session.defaultSession.setPermissionCheckHandler(
        (wc, permission, origin) =>
          permission === "fullscreen" &&
          wc === window?.webContents &&
          origin === "obelisk://app",
      );
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ["https://tile.openstreetmap.org/*"] },
        (details, callback) => {
          details.requestHeaders["User-Agent"] = USER_AGENT;
          callback({ requestHeaders: details.requestHeaders });
        },
      );
      wireIPC();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [
                {
                  label: "Obelisk",
                  submenu: [
                    { role: "about" },
                    { type: "separator" },
                    { role: "quit" },
                  ],
                },
              ]
            : []),
          {
            label: "File",
            submenu: [
              {
                label: "Add Files…",
                accelerator: "CmdOrCtrl+O",
                click: () => window?.webContents.send("menu:import"),
              },
              {
                label: "Add Folder…",
                accelerator: "CmdOrCtrl+Shift+O",
                click: () => window?.webContents.send("menu:import-folder"),
              },
              {
                label: "Switch Library…",
                click: () => window?.webContents.send("menu:archive"),
              },
              { type: "separator" },
              { role: "close" },
            ],
          },
          { role: "editMenu" },
          {
            label: "View",
            submenu: [
              {
                label: "Appearance",
                submenu: [
                  ["Light", "light"],
                  ["Dark", "dark"],
                  ["Match System", "system"],
                ].map(([label, theme]) => ({
                  label,
                  click: () => window?.webContents.send("menu:theme", theme),
                })),
              },
              {
                label: "Keyboard Shortcuts",
                click: () => window?.webContents.send("menu:shortcuts"),
              },
              { type: "separator" },
              { role: "reload" },
              { role: "toggleDevTools" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
        ]),
      );
      await createWindow();
      void ensureAppCopy();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
      app.on("window-all-closed", () => app.quit());
      app.on("before-quit", (event) => {
        if (!closing) {
          event.preventDefault();
          closing = true;
          zimReader.close();
          Promise.resolve(appCopyPromise)
            .catch(() => {})
            .then(() => library.close())
            .finally(() => app.quit());
        }
      });
    })
    .catch((error) => {
      console.error(error);
      dialog.showErrorBox("Obelisk could not start", error.message);
      app.quit();
    });
}
