import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { wikipediaCatalog, wikipediaPlan } from './wikipedia.js';
import { searchPodcasts, loadPodcast, podcastPlan } from './podcasts.js';
import { mapCatalog, mapPlan, searchPlaces, validateRegion } from './maps.js';
import { mapToolAvailable, measureMap } from '../core/map-tools.js';

/** Persistent discovery cache; acquisition plans always resolve on the server. */
export async function createSources({ root, catalog, downloads }) {
  const file = path.join(root, 'sources.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, cache: {}, followed: [] }; }
  let pendingSave = Promise.resolve();
  function save() {
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(state)); await rename(file + '.tmp', file);
    }); return pendingSave;
  }
  async function cached(key, loader, refresh) {
    const previous = state.cache[key];
    if (!refresh && previous && Date.now() - previous.fetched < 3600000) return { ...previous.data, cached: true, stale: false };
    try {
      const data = await loader(); state.cache[key] = { fetched: Date.now(), data };
      const keys = Object.keys(state.cache).sort((a,b) => state.cache[a].fetched - state.cache[b].fetched);
      for (const old of keys.slice(0, Math.max(0, keys.length - 64))) delete state.cache[old];
      await save(); return { ...data, cached: false, stale: false };
    } catch (error) {
      if (previous) return { ...previous.data, cached: true, stale: true, warning: `Showing saved results. Refresh failed: ${error.message}` };
      throw error;
    }
  }
  const token = (kind, id) => `${kind}:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
  const choices = new Map();
  function register(kind, id, value) { const key = token(kind, id); choices.set(key, { kind, value }); if (choices.size > 2000) choices.delete(choices.keys().next().value); return key; }
  function saved(source) { return catalog.list().find(i => !i.placeholder && i.source?.seriesKey === source.seriesKey && i.source?.version === source.version); }
  return {
    status: async () => ({ podcastIndex: Boolean(process.env.PODCAST_INDEX_KEY && process.env.PODCAST_INDEX_SECRET), mapTool: await mapToolAvailable(), followed: state.followed }),
    async wikipedia(input) {
      const data = await cached(`wiki:${input.language || 'eng'}:${input.query || ''}:${input.start || 0}`, () => wikipediaCatalog(input), input.refresh);
      return { ...data, entries: data.entries.map(entry => {
        const editions = catalog.list().filter(i => i.source?.seriesKey === entry.seriesKey);
        const local = editions.find(i => i.source.version === entry.version);
        return { ...entry, key: register('wikipedia', entry.id, entry), saved: Boolean(local), updateAvailable: editions.some(i => i.source.version < entry.version), localVersions: editions.map(i => i.source.version) };
      }) };
    },
    search: (query, provider, refresh) => cached(`search:${provider}:${query}`, () => searchPodcasts(query, provider), refresh),
    async feed(url, refresh) {
      const data = await cached(`feed:${url}`, () => loadPodcast(url), refresh);
      return { ...data, followed: state.followed.some(s => s.feedUrl === data.feedUrl), episodes: data.episodes.map(episode => {
        const plan = podcastPlan(episode, data.rights);
        return { ...episode, key: register('podcast', `${data.feedUrl}:${episode.guid}`, { episode, rights: data.rights }), saved: Boolean(saved(plan.source)) };
      }) };
    },
    async follow(feedUrl) {
      const data = await this.feed(feedUrl);
      if (!state.followed.some(s => s.feedUrl === data.feedUrl)) {
        if (state.followed.length >= 100) throw new Error('The saved-show limit is 100.');
        state.followed.push({ title: data.title, feedUrl: data.feedUrl, id: data.id }); await save();
      }
      return { followed: state.followed };
    },
    maps: refresh => cached('maps', () => mapCatalog(), refresh),
    async acquire(key) {
      const choice = choices.get(key);
      if (!choice) throw new Error('These results have expired. Refresh the source and select the item again.');
      const plan = choice.kind === 'wikipedia' ? await wikipediaPlan(choice.value) : podcastPlan(choice.value.episode, choice.value.rights);
      return downloads.addPlan(plan);
    },
    places: (query) => cached(`places:${String(query).trim().toLowerCase()}`, () => searchPlaces(query), false),
    /** Exact size of a map before saving it; null when it cannot be worked out. */
    async mapSize(input) {
      const { bbox, zoom } = validateRegion(input), build = (await this.maps(false)).builds[0];
      return build ? measureMap({ url: build.url, bbox, zoom }) : null;
    },
    async acquireMap(input) {
      if (!await mapToolAvailable()) throw new Error('Install the map extractor with npm run setup:maps first.');
      const data = await this.maps(false);
      const build = data.builds.find(b => b.id === input.build) || data.builds[0], plan = mapPlan(input, build);
      // The extractor's dry run reports the exact size, so Transfers can show a real percentage.
      const measured = await measureMap({ url: build.url, bbox: plan.bbox, zoom: plan.zoom }).catch(() => null);
      return downloads.addPlan(measured ? { ...plan, estimatedBytes: measured.bytes } : plan);
    },
  };
}
