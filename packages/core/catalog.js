import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeItem } from "../types/index.js";

export function openCatalog(root) {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "catalog.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  const put = (table, value) =>
    db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
  // Bumped on every change to items, so readers can tell when their copy is stale.
  let revision = 0;
  return {
    get revision() {
      return revision;
    },
    /** Runs many writes as one transaction; far faster for whole-archive rebuilds. */
    batch(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    count: () => db.prepare("SELECT count(*) AS n FROM items").get().n,
    list: () =>
      db
        .prepare("SELECT data FROM items ORDER BY rowid DESC")
        .all()
        .map((r) => JSON.parse(r.data)),
    get: (id) => {
      const r = db.prepare("SELECT data FROM items WHERE id=?").get(id);
      return r ? JSON.parse(r.data) : null;
    },
    put: (value) => {
      revision++;
      return put("items", value);
    },
    remove: (id) => {
      revision++;
      return db.prepare("DELETE FROM items WHERE id=?").run(id);
    },
    jobs: () =>
      db
        .prepare("SELECT data FROM jobs ORDER BY rowid DESC")
        .all()
        .map((r) => JSON.parse(r.data)),
    job: (id) => {
      const r = db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
      return r ? JSON.parse(r.data) : null;
    },
    putJob: (value) => put("jobs", value),
    removeJob: (id) => db.prepare("DELETE FROM jobs WHERE id=?").run(id),
    close: () => db.close(),
  };
}

/**
 * An item is wherever its item.json is. The `path` written in the manifest is only a
 * hint from when it was last saved; the folder it is found in wins.
 */
function located(item, archiveRoot, directory, beside) {
  if (typeof item.filename !== "string") return item;
  const at = path.relative(archiveRoot, directory).split(path.sep).filter(Boolean);
  // A file the check found apart from its manifest keeps the path it recorded.
  if (item.manifestPath && !beside) return { ...item, manifestPath: [...at, "item.json"].join("/") };
  const { manifestPath, ...rest } = item;
  return { ...rest, path: [...at, item.filename].join("/") };
}
const besideSync = (item, directory) =>
  !item.manifestPath || typeof item.filename !== "string" || existsSync(path.join(directory, item.filename));
const beside = (item, directory) =>
  !item.manifestPath || typeof item.filename !== "string"
    ? true
    : access(path.join(directory, item.filename)).then(() => true, () => false);

/** Only our bounded layout is scanned. Rebuilding does not move or execute files. */
export function rebuildCatalog(catalog, archiveRoot) {
  let count = 0;
  function walk(directory, depth = 0) {
    if (depth > 24) return;
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (
        !child.isDirectory() ||
        ["Library", ".obelisk"].includes(child.name)
      )
        continue;
      const childPath = path.join(directory, child.name);
      try {
        const item = JSON.parse(
          readFileSync(path.join(childPath, "item.json"), "utf8"),
        );
        if (
          item.schemaVersion === 1 &&
          typeof item.id === "string" &&
          typeof item.title === "string"
        ) {
          const value = normalizeItem(item);
          catalog.put(located(value, archiveRoot, childPath, besideSync(value, childPath)));
          count++;
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          console.warn("Skipped unreadable manifest:", childPath);
      }
      walk(childPath, depth + 1);
    }
  }
  catalog.batch(() => walk(archiveRoot));
  return count;
}

/**
 * The same scan without blocking: manifests are read a batch at a time and only
 * those that differ from the index are written. An entry edited while the scan ran
 * is left alone, so a slow scan never undoes a newer change.
 */
export async function syncCatalog(catalog, archiveRoot, { stopped = () => false } = {}) {
  const found = [];
  async function visit(childPath, depth) {
    try {
      const item = JSON.parse(await readFile(path.join(childPath, "item.json"), "utf8"));
      if (item.schemaVersion === 1 && typeof item.id === "string" && typeof item.title === "string") {
        const normal = normalizeItem(item),
          value = located(normal, archiveRoot, childPath, await beside(normal, childPath)),
          before = JSON.stringify(catalog.get(value.id));
        if (before !== JSON.stringify(value)) found.push({ value, before });
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("Skipped unreadable manifest:", childPath);
    }
    await walk(childPath, depth + 1);
  }
  async function walk(directory, depth = 0) {
    if (depth > 24 || stopped()) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const folders = children.filter((c) => c.isDirectory() && !["Library", ".obelisk"].includes(c.name));
    for (let i = 0; i < folders.length && !stopped(); i += 32)
      await Promise.all(folders.slice(i, i + 32).map((c) => visit(path.join(directory, c.name), depth)));
  }
  await walk(archiveRoot);
  if (stopped()) return 0;
  const fresh = found.filter(({ value, before }) => JSON.stringify(catalog.get(value.id)) === before);
  if (fresh.length) catalog.batch(() => fresh.forEach(({ value }) => catalog.put(value)));
  return fresh.length;
}
