// Folders: real directories that Obelisk keeps, each marked by a folder.json
// holding its ID, display name and icon. Item folders (a file and its item.json)
// sit inside them. See docs/folders.md.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, lstat, access } from "node:fs/promises";
import path from "node:path";
import { packageOf } from "./bundle.js";
import { writeJson, insideLibrary, OUTSIDE } from "./archive.js";

export const FOLDER_FILE = "folder.json";
const ITEM_FILE = "item.json";
const META = ".obelisk";

/** The starting folders of a new library, and which importers save where. */
const DEFAULTS = [
  { key: "inbox", name: "Inbox", icon: "inbox" },
  { key: "documents", name: "Documents", icon: "book", children: [{ key: "books", name: "Books", icon: "book" }] },
  { key: "audio", name: "Audio", icon: "audio", children: [
    { key: "music", name: "Music", icon: "music" },
    { key: "podcasts", name: "Podcasts", icon: "podcast" },
    { key: "audiobooks", name: "Audiobooks", icon: "headphones" },
  ] },
  { key: "video", name: "Video", icon: "video" },
  { key: "images", name: "Images", icon: "image", children: [{ key: "photos", name: "Photos", icon: "camera" }] },
  { key: "maps", name: "Maps", icon: "map" },
  { key: "reference", name: "Reference", icon: "encyclopedia", children: [
    { key: "wikipedia", name: "Wikipedia", icon: "encyclopedia" },
    { key: "websites", name: "Websites", icon: "browser" },
  ] },
  { key: "software", name: "Software", icon: "software" },
  { key: "backups", name: "Backups", icon: "archive" },
  { key: "other", name: "Other", icon: "file" },
];
const NEW_DESTINATIONS = {
  web: "websites", wikipedia: "wikipedia", maps: "maps", podcasts: "podcasts", video: "video", software: "software",
  "files:document": "documents", "files:audio": "audio", "files:video": "video", "files:image": "images",
  "files:map": "maps", "files:reference": "reference", "files:software": "software", "files:other": "other",
};
// Libraries from before folders: shelf directories become folders and importers keep
// saving where they did.
const SHELF_DIRS = { Documents: "book", Audio: "audio", Video: "video", Images: "image", Maps: "map", Reference: "encyclopedia", Software: "software", Other: "file" };
const OLD_DESTINATIONS = {
  web: "Reference", wikipedia: "Reference", maps: "Maps", podcasts: "Audio", video: "Video", software: "Software",
  "files:document": "Documents", "files:audio": "Audio", "files:video": "Video", "files:image": "Images",
  "files:map": "Maps", "files:reference": "Reference", "files:software": "Software", "files:other": "Other",
};
export const DESTINATION_KEYS = Object.keys(NEW_DESTINATIONS);

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** A directory name as close to the display name as every platform allows. */
export function safeName(name) {
  let out = String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 80)
    .replace(/[\s.]+$/g, "");
  if (!out) out = "Folder";
  if (RESERVED.test(out)) out += "-";
  return out;
}
const same = (a, b) => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
const posix = (p) => p.split(path.sep).join("/");
const exists = (file) => access(file).then(() => true, () => false);


/**
 * Opens the folder tree of a library. `catalog` is updated whenever a folder's
 * directory changes, so item paths always match the disk.
 */
export async function openFolders({ archiveRoot, catalog, fresh = false }) {
  const metaDir = path.join(archiveRoot, META),
    settingsFile = path.join(metaDir, "library.json"),
    journalFile = path.join(metaDir, "journal.json");
  await mkdir(metaDir, { recursive: true });
  let settings = null;
  try {
    settings = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch {}
  const folders = new Map(); // id → { id, name, icon, source, parent, dir }
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.catch(() => {}).then(task);
    queue = next;
    return next;
  };

  const abs = (dir) => path.join(archiveRoot, ...dir.split("/").filter(Boolean));
  const record = (folder) => {
    const { id, name, icon, source, position } = folder;
    return {
      schemaVersion: 1,
      id,
      name,
      ...(icon ? { icon } : {}),
      ...(source ? { source } : {}),
      ...(Number.isInteger(position) ? { position } : {}),
    };
  };
  const save = async (folder) => {
    if (!(await contained(join(folder.dir, FOLDER_FILE)))) throw new Error(OUTSIDE);
    return writeJson(path.join(abs(folder.dir), FOLDER_FILE), record(folder));
  };
  const saveSettings = () => writeJson(settingsFile, settings);

  /** Reads every folder under the root. Directories without folder.json are adopted. */
  async function scan() {
    folders.clear();
    const seen = new Set();
    async function walk(dir, parent, depth) {
      if (depth > 24) return;
      let children;
      try {
        children = await readdir(abs(dir), { withFileTypes: true });
      } catch {
        return;
      }
      const found = [],
        dirs = children.filter((c) => c.isDirectory() && !c.name.startsWith(".") && !(depth === 0 && c.name === "Library"));
      // A few at a time: a folder may hold tens of thousands of item folders.
      for (let i = 0; i < dirs.length; i += 64)
        await Promise.all(
          dirs.slice(i, i + 64).map(async (child) => {
            const rel = dir ? `${dir}/${child.name}` : child.name,
              full = abs(rel);
            let data = null;
            try {
              data = JSON.parse(await readFile(path.join(full, FOLDER_FILE), "utf8"));
            } catch (error) {
              // An item folder, a package (one file to macOS), or a folder made elsewhere.
              if (error.code === "ENOENT" && ((await exists(path.join(full, ITEM_FILE))) || packageOf(full))) return;
            }
            found.push({ rel, name: child.name, data });
          }),
        );
      for (const { rel, name, data } of found.sort((a, b) => a.rel.localeCompare(b.rel))) {
        let folder = {
          id: typeof data?.id === "string" ? data.id : null,
          name: typeof data?.name === "string" && data.name.trim() ? data.name : name,
          icon: typeof data?.icon === "string" ? data.icon : SHELF_DIRS[name] && !parent ? SHELF_DIRS[name] : "",
          source: data?.source?.key ? { key: String(data.source.key) } : undefined,
          // Where it was dragged among its siblings; without one it sorts by name.
          position: Number.isInteger(data?.position) ? data.position : undefined,
          parent,
          dir: rel,
        };
        // A folder copied in Finder carries its original's ID; the copy gets its own.
        const fixed = !folder.id || seen.has(folder.id);
        if (fixed) folder.id = randomUUID();
        seen.add(folder.id);
        folders.set(folder.id, folder);
        if (fixed || !data) await save(folder).catch(() => {});
        await walk(rel, folder.id, depth + 1);
      }
    }
    await walk("", null, 0);
  }

  /** A relative path that stays inside the library, symlinks included. */
  async function contained(rel) {
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p === ""))
      return false;
    return insideLibrary(archiveRoot, abs(rel));
  }
  // Why the last recovery couldn't finish, said to whoever tries the next operation.
  let unfinished = "";
  /** Finishes a multi-step operation that a crash or an error interrupted. */
  async function recover() {
    let plan;
    try {
      plan = JSON.parse(await readFile(journalFile, "utf8"));
    } catch {
      return;
    }
    for (const step of plan.steps || []) {
      // A journal is a file in the library; never trust it to point outside.
      if (!(await contained(step.from)) || !(await contained(step.to))) continue;
      const from = abs(step.from),
        to = abs(step.to);
      // Both there means something else took the destination, so this move never
      // happened. It stays written down, unfinished, and the index stays with the files.
      if ((await exists(from)) && (await exists(to))) {
        unfinished = `“${step.to}” is in the way of an earlier move from “${step.from}”. Move or rename it, then try again.`;
        return false;
      }
      if (await exists(from)) {
        try {
          await mkdir(path.dirname(to), { recursive: true });
          await rename(from, to);
        } catch {
          // The plan stays written down, and the next opening tries again. Later steps
          // wait: they may depend on this one.
          unfinished = `An earlier move from “${step.from}” to “${step.to}” couldn’t finish. Try again, or reopen the library.`;
          return false;
        }
      }
      // Whether the rename happened before the crash or just now, the index follows it.
      if (await exists(to)) relocate(step.from, step.to);
    }
    await rm(journalFile, { force: true });
    return true;
  }
  /**
   * Runs renames as one plan, written down first. If a rename fails, the ones already
   * made are undone, so a failed operation changes nothing; if even that fails, the plan
   * is finished instead, now or when the library next opens. A crash is finished too.
   */
  async function run(steps, after = async () => {}) {
    if (!steps.length) return after();
    // There's one plan at a time: an earlier one is finished first, and while it can't
    // be, nothing is written over it.
    if ((await recover()) === false) throw new Error(unfinished);
    // A folder since replaced by a link to somewhere else is never followed.
    for (const step of steps)
      if (!(await contained(step.from)) || !(await contained(step.to))) throw new Error(OUTSIDE);
    await writeJson(journalFile, { schemaVersion: 1, steps });
    const done = [],
      made = [];
    try {
      for (const step of steps) {
        const parent = path.dirname(abs(step.to));
        if (!(await exists(parent))) made.push(parent);
        await mkdir(parent, { recursive: true });
        await rename(abs(step.from), abs(step.to));
        done.push(step);
      }
    } catch (e) {
      try {
        for (const step of done.reverse()) await rename(abs(step.to), abs(step.from));
        // Folders made for the move would otherwise be read as new, empty folders.
        for (const dir of made.reverse()) await rmdir(dir).catch(() => {});
        await rm(journalFile, { force: true });
      } catch {
        await recover().catch(() => {});
      }
      throw e;
    }
    try {
      await after();
    } catch (e) {
      // Everything moved; only the index lags, and it follows the disk.
      await recover().catch(() => {});
      throw e;
    }
    await rm(journalFile, { force: true });
  }

  /** Points item and manifest paths at or under `from` to `to` in the catalog. */
  function relocate(from, to) {
    const moved = (value) =>
      typeof value === "string" && (value === from || value.startsWith(from + "/")) ? to + value.slice(from.length) : value;
    catalog.batch(() => {
      for (const item of catalog.list())
        if (moved(item.path) !== item.path || moved(item.manifestPath) !== item.manifestPath)
          catalog.put({ ...item, path: moved(item.path), ...(item.manifestPath && { manifestPath: moved(item.manifestPath) }) });
    });
  }
  /** Whether the manifest at `rel` belongs to item `id`. */
  async function manifestOf(rel, id) {
    try {
      return JSON.parse(await readFile(abs(rel), "utf8")).id === id;
    } catch {
      return false;
    }
  }
  /** An item owns its directory when it holds only the file and its own manifest. */
  async function ownsFolder(item, dir) {
    if (!dir || dir === "." || item.manifestPath || [...folders.values()].some((f) => f.dir === dir)) return false;
    if (!(await manifestOf(join(dir, "item.json"), item.id))) return false;
    const names = (await readdir(abs(dir)).catch(() => [])).filter((n) => n !== ".DS_Store");
    return names.every((n) => n === "item.json" || n === path.posix.basename(item.path));
  }
  function moveRecords(from, to) {
    for (const folder of folders.values())
      if (folder.dir === from || folder.dir.startsWith(from + "/")) folder.dir = to + folder.dir.slice(from.length);
  }

  /** A directory name under `parentDir` not used by any sibling (ignoring case). */
  async function freeName(parentDir, wanted, except = null) {
    const names = (await readdir(abs(parentDir)).catch(() => [])).filter((n) => !except || !same(n, except));
    const base = safeName(wanted);
    let name = base;
    for (let n = 2; names.some((taken) => same(taken, name)); n++) name = `${base} ${n}`;
    return name;
  }
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);
  const dirOf = (id) => (id ? folders.get(id)?.dir ?? null : "");
  function need(id) {
    const folder = folders.get(id);
    if (!folder) throw new Error("This folder no longer exists.");
    return folder;
  }
  const inside = (id, ancestor) => {
    for (let at = folders.get(id); at; at = folders.get(at.parent)) if (at.id === ancestor) return true;
    return false;
  };
  function cleanIcon(icon) {
    return typeof icon === "string" && /^[a-z-]{1,40}$/.test(icon) ? icon : "";
  }
  function cleanName(name) {
    const text = String(name ?? "").trim().slice(0, 120);
    if (!text) throw new Error("Give the folder a name.");
    return text;
  }

  async function create(parentId, name, icon = "", source) {
    const parentDir = dirOf(parentId);
    if (parentDir === null) throw new Error("This folder no longer exists.");
    const display = cleanName(name),
      dir = join(parentDir, await freeName(parentDir, display));
    if (!(await contained(dir))) throw new Error(OUTSIDE);
    await mkdir(abs(dir));
    const folder = { id: randomUUID(), name: display, icon: cleanIcon(icon), source, parent: parentId || null, dir };
    await save(folder);
    folders.set(folder.id, folder);
    return folder;
  }

  // Before folders: lay out defaults for a new library, or adopt an existing one.
  await recover();
  await scan();
  if (!settings) {
    const byDir = (dir) => [...folders.values()].find((f) => !f.parent && same(f.dir, dir));
    settings = { schemaVersion: 1, inbox: null, destinations: {}, defaultsCreated: true };
    if (fresh && !folders.size) {
      const keys = {};
      for (const top of DEFAULTS) {
        const made = await create(null, top.name, top.icon);
        keys[top.key] = made.id;
        for (const sub of top.children || []) keys[sub.key] = (await create(made.id, sub.name, sub.icon)).id;
      }
      settings.inbox = keys.inbox;
      for (const [importer, key] of Object.entries(NEW_DESTINATIONS)) settings.destinations[importer] = keys[key];
    } else {
      settings.inbox = (byDir("Inbox") || (await create(null, "Inbox", "inbox"))).id;
      for (const [importer, dir] of Object.entries(OLD_DESTINATIONS)) {
        const folder = byDir(dir);
        if (folder) settings.destinations[importer] = folder.id;
      }
      // Podcast shows were already their own folders; they keep receiving episodes.
      for (const item of catalog.list())
        if (item.collection?.id && item.path) {
          const showDir = posix(path.dirname(path.dirname(item.path))),
            show = [...folders.values()].find((f) => f.dir === showDir);
          if (show && !show.source) {
            show.source = { key: `podcast:${item.collection.id}` };
            // Old show directories end in "--<feed id>"; the folder shows the show's name.
            if (item.collection.title) show.name = String(item.collection.title).slice(0, 120);
            show.icon ||= "podcast";
            await save(show).catch(() => {});
          }
        }
    }
    await saveSettings();
  }
  // Inbox always exists; if its directory went missing it is made again.
  if (!folders.has(settings.inbox)) {
    settings.inbox = (await create(null, "Inbox", "inbox")).id;
    await saveSettings();
  }

  return {
    list: () => [...folders.values()].map((f) => ({ ...f })),
    get: (id) => (folders.has(id) ? { ...folders.get(id) } : null),
    get inbox() {
      return settings.inbox;
    },
    dirOf,
    /** The folder an item's file is in: its item folder's parent. Null at the root. */
    folderOf(itemPath) {
      const dir = posix(path.dirname(path.dirname(itemPath || "")));
      if (!dir || dir === ".") return null;
      for (const folder of folders.values()) if (folder.dir === dir) return folder.id;
      return null;
    },
    destinations: () => ({ ...settings.destinations }),
    /** Where an importer saves, or null if it has none (never chosen, or deleted). */
    destination(key) {
      const id = settings.destinations[key];
      return id && folders.has(id) ? id : null;
    },
    setDestination: (key, id) =>
      serial(async () => {
        if (!DESTINATION_KEYS.includes(key)) throw new Error("Unknown importer.");
        need(id);
        settings.destinations[key] = id;
        await saveSettings();
      }),
    create: (parentId, name, icon) => serial(() => create(parentId, name, icon)),
    rename: (id, name) =>
      serial(async () => {
        const folder = need(id),
          display = cleanName(name),
          parentDir = dirOf(folder.parent),
          current = path.posix.basename(folder.dir);
        folder.name = display;
        // The directory follows the name where it safely can.
        if (safeName(display) !== current) {
          const wanted = await freeName(parentDir, display, current),
            to = join(parentDir, wanted);
          if (same(wanted, current)) {
            // Only the case changed: most Macs need a stop in between.
            const via = join(parentDir, `${wanted}.${randomUUID().slice(0, 8)}`);
            await run([{ from: folder.dir, to: via }, { from: via, to }]);
          } else await run([{ from: folder.dir, to }]);
          relocate(folder.dir, to);
          moveRecords(folder.dir, to);
        }
        await save(folder);
        return { ...folder };
      }),
    setIcon: (id, icon) =>
      serial(async () => {
        const folder = need(id);
        folder.icon = cleanIcon(icon);
        await save(folder);
        return { ...folder };
      }),
    move: (id, parentId) =>
      serial(async () => {
        const folder = need(id);
        if (parentId && (parentId === id || inside(parentId, id))) throw new Error("A folder can’t go inside itself.");
        if ((folder.parent || null) === (parentId || null)) return { ...folder };
        const parentDir = dirOf(parentId);
        if (parentDir === null) throw new Error("That folder no longer exists.");
        const to = join(parentDir, await freeName(parentDir, path.posix.basename(folder.dir)));
        await run([{ from: folder.dir, to }]);
        relocate(folder.dir, to);
        moveRecords(folder.dir, to);
        folder.parent = parentId || null;
        // Its place among the old siblings means nothing among the new ones.
        if (folder.position !== undefined) {
          delete folder.position;
          await save(folder);
        }
        return { ...folder };
      }),
    /** Puts folders in this order among their siblings in `parentId`. */
    order: (parentId, ids) =>
      serial(async () => {
        const siblings = ids.map((id) => folders.get(id)).filter((f) => f && (f.parent || null) === (parentId || null));
        for (const [position, folder] of siblings.entries())
          if (folder.position !== position) {
            folder.position = position;
            await save(folder);
          }
        return siblings.map((f) => f.id);
      }),
    /**
     * Deletes a folder. With `keep`, everything in it moves up one level first.
     * Otherwise the folder and its contents go to `trash` (the system Trash).
     */
    remove: (id, { keep = true, trash, busy = () => false } = {}) =>
      serial(async () => {
        const folder = need(id);
        if (id === settings.inbox) throw new Error("Inbox can’t be deleted.");
        if (busy(folder.dir)) throw new Error("A download is saving into this folder. Wait for it, or cancel it first.");
        const parentDir = dirOf(folder.parent);
        if (keep) {
          const steps = [],
            taken = new Set((await readdir(abs(parentDir)).catch(() => [])).map((n) => n.toLowerCase()));
          for (const name of await readdir(abs(folder.dir))) {
            if (name === FOLDER_FILE || name === ".DS_Store") continue;
            let target = name;
            for (let n = 2; taken.has(target.toLowerCase()); n++) {
              const ext = path.extname(name);
              target = `${path.basename(name, ext)} ${n}${ext}`;
            }
            taken.add(target.toLowerCase());
            steps.push({ from: join(folder.dir, name), to: join(parentDir, target) });
          }
          await run(steps, async () => {
            for (const step of steps) {
              relocate(step.from, step.to);
              moveRecords(step.from, step.to);
            }
          });
          for (const child of folders.values()) if (child.parent === id) child.parent = folder.parent || null;
        }
        // Anything still inside (everything, without `keep`) goes with the folder.
        const gone = [...folders.values()].filter((f) => f.dir === folder.dir || f.dir.startsWith(folder.dir + "/"));
        if (!trash) throw new Error("Nowhere to send the folder.");
        await trash(abs(folder.dir));
        const removed = catalog.list().filter((i) => typeof i.path === "string" && i.path.startsWith(folder.dir + "/"));
        catalog.batch(() => removed.forEach((i) => catalog.remove(i.id)));
        for (const f of gone) folders.delete(f.id);
        for (const [key, value] of Object.entries(settings.destinations))
          if (!folders.has(value)) delete settings.destinations[key];
        await saveSettings();
        return { removed: removed.map((i) => i.id) };
      }),
    /** Moves items into a folder (null: the root's Inbox). */
    moveItems: (ids, folderId) =>
      serial(async () => {
        const targetId = folderId || settings.inbox,
          targetDir = dirOf(targetId);
        if (targetDir === null) throw new Error("That folder no longer exists.");
        const steps = [],
          plans = [],
          taken = new Set((await readdir(abs(targetDir)).catch(() => [])).map((n) => n.toLowerCase()));
        const fresh = (own) => {
          let name = own;
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${own} ${n}`;
          taken.add(name.toLowerCase());
          return join(targetDir, name);
        };
        for (const id of new Set(ids)) {
          const item = catalog.get(id);
          if (!item?.path) continue;
          const from = posix(path.dirname(item.path)),
            owned = await ownsFolder(item, from);
          if (owned && (posix(path.dirname(from)) === targetDir || (path.dirname(from) === "." && !targetDir))) continue;
          if (owned) {
            const to = fresh(path.posix.basename(from));
            steps.push({ from, to });
            plans.push({ id, path: `${to}/${path.posix.basename(item.path)}` });
            continue;
          }
          // A file sharing its folder (or apart from its manifest) moves on its own,
          // into a new item folder with its manifest, so nothing else comes with it.
          const to = fresh(safeName(path.posix.parse(item.path).name)),
            manifest = item.manifestPath || join(from, "item.json");
          steps.push({ from: item.path, to: `${to}/${path.posix.basename(item.path)}` });
          if (await manifestOf(manifest, id)) steps.push({ from: manifest, to: `${to}/item.json` });
          plans.push({ id, path: `${to}/${path.posix.basename(item.path)}`, apart: true });
        }
        await run(steps, async () => {
          catalog.batch(() => {
            for (const plan of plans) {
              const { manifestPath, ...item } = catalog.get(plan.id);
              catalog.put({ ...item, path: plan.path, ...(!plan.apart && manifestPath && { manifestPath }) });
            }
          });
        });
        return plans.map((p) => p.id);
      }),
    /**
     * The folder a repeated source (a podcast show) saves into: the one that records
     * its key, wherever it now is; otherwise a new one in `parentId`.
     */
    /**
     * The folder at a path of default names, like ["Documents", "Books"], found by
     * name at each level and made where it's missing.
     */
    pathFolder: (names) =>
      serial(async () => {
        let parent = null;
        for (const name of names) {
          const found = [...folders.values()].find((f) => (f.parent || null) === parent && same(f.name, name));
          const icon = DEFAULTS.flatMap((d) => [d, ...(d.children || [])]).find((d) => d.name === name)?.icon || "";
          parent = (found || (await create(parent, name, icon))).id;
        }
        return parent;
      }),
    sourceFolder: (key, name, parentId, icon = "") =>
      serial(async () => {
        for (const folder of folders.values()) if (folder.source?.key === key) return folder.id;
        return (await create(parentId, name, icon, { key })).id;
      }),
    /** Re-reads the tree, picking up folders made or moved outside the app. */
    rescan: () => serial(scan),
    whenIdle: () => queue.catch(() => {}),
  };
}
