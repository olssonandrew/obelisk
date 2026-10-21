/**
 * Where the app gets collections: the copy published from the repository's main
 * branch, cached between launches, and the copy shipped with this release for first
 * launch and offline use. Whichever is newer wins.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readBundle } from "./format.js";
import { USER_AGENT } from "../core/http-transfer.js";

const DAY = 24 * 3600 * 1000;

export function createCollectionSource({ bundled, cacheFile, url = "", fetch: fetchImpl = fetch, now = () => Date.now() }) {
  let current = null,
    cache = null,
    checking = null;
  const newer = (a, b) => (!b || (a?.built || "") > (b.built || "") ? a : b);
  async function load() {
    if (current) return current;
    let shipped = null;
    try {
      shipped = readBundle(JSON.parse(await readFile(bundled, "utf8")));
    } catch {}
    try {
      cache = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {}
    let cached = null;
    try {
      if (cache?.bundle) cached = readBundle(cache.bundle);
    } catch {}
    current = newer(cached, shipped) || { built: null, featured: [], collections: [], skipped: [] };
    return current;
  }
  async function save(entry) {
    cache = entry;
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry));
    await rename(temporary, cacheFile);
  }
  /** Asks for a newer list, at most once a day unless `force`; an unchanged list costs one small request. */
  async function refresh(force = false) {
    await load();
    if (!url || (!force && cache?.checkedAt && now() - cache.checkedAt < DAY)) return false;
    checking ||= (async () => {
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, ...(cache?.etag ? { "If-None-Match": cache.etag } : {}) },
          signal: AbortSignal.timeout(20000),
        });
        if (response.status === 304) {
          await save({ ...cache, checkedAt: now() });
          return false;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bundle = await response.json(),
          read = readBundle(bundle);
        await save({ bundle, etag: response.headers.get("etag") || null, checkedAt: now() });
        // What main holds now is the list, withdrawals included.
        const before = JSON.stringify(current);
        current = read;
        return JSON.stringify(current) !== before;
      } catch {
        // Offline or unreachable: the list already here stays, and it's asked again next time.
        return false;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }
  return {
    load,
    refresh,
    async get(id) {
      return (await load()).collections.find((c) => c.id === id) || null;
    },
  };
}
