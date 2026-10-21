import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parsePodcast, podcastPlan, podcastIndexHeaders, searchPodcasts } from '../packages/sources/podcasts.js';
import { parseWikipedia, parseMetalink } from '../packages/sources/wikipedia.js';
import { validateRegion, mapPlan, searchPlaces } from '../packages/sources/maps.js';
import { parseXml } from '../packages/sources/xml.js';
import { openCatalog, rebuildCatalog } from '../packages/core/catalog.js';
import { importFile } from '../packages/core/archive.js';
import { createDownloads } from '../packages/core/downloads.js';

const rss = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>A &amp; B</title><copyright>Publisher retains rights</copyright><item><title>One / Two</title><itunes:title>One / Two</itunes:title><guid>stable-1</guid><pubDate>Fri, 09 Oct 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Hello &amp; welcome</p>]]></description><enclosure url="https://example.org/audio?id=1" type="audio/mpeg" length="123"/></item><item><title>Repeated</title><guid>stable-1</guid><enclosure url="https://example.org/duplicate.mp3" type="audio/mpeg"/></item><item><title>No media</title></item><item><title>Unsafe link</title><enclosure url="file:///secret" type="audio/mpeg"/></item></channel></rss>`;
test('RSS preserves namespaced titles, stable identities, dates, and enclosure formats', () => {
  const show = parsePodcast(rss, 'https://example.org/feed.xml');
  assert.equal(show.title, 'A & B'); assert.equal(show.episodes.length, 1); assert.equal(show.episodes[0].title, 'One / Two');
  const plan = podcastPlan(show.episodes[0], show.rights);
  assert.equal(plan.type, 'audio'); assert.equal(plan.kind, 'podcast'); assert.match(plan.filename, /^2026-10-09 - One - Two - .*\.mp3$/);
  assert.equal(plan.source.episodeId, 'stable-1'); assert.equal(plan.rights, 'Publisher retains rights');
  assert.equal(plan.collection.title, 'A & B'); assert.equal(plan.expectedBytes, undefined, 'RSS enclosure sizes may change with dynamic ads');
});
test('Atom enclosures work and XML custom entities are rejected', () => {
  const atom = '<feed><title>Show</title><entry><title>Episode</title><id>1</id><link rel="enclosure" type="audio/mp4" href="/episode.m4a"/></entry></feed>';
  assert.equal(parsePodcast(atom, 'https://example.org/feed').episodes[0].url, 'https://example.org/episode.m4a');
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>'), /entities/);
});
test('public podcast search does not require credentials and deduplicates feeds', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ results: [1, 2].map(id => ({ collectionId: id, collectionName: 'Show', feedUrl: 'https://example.org/rss' })) }));
  const data = await searchPodcasts('show', 'apple', { fetchImpl }); assert.equal(data.shows.length, 1);
  assert.equal(podcastIndexHeaders('key', 'secret', 123).Authorization, createHash('sha1').update('keysecret123').digest('hex'));
});
test('Wikipedia OPDS and Metalink are parsed separately; checksum belongs to the selected file', () => {
  const xml = '<feed><totalResults>1</totalResults><entry><id>123</id><title>Wikipedia</title><language>eng</language><name>wikipedia_en_all</name><flavour>mini</flavour><updated>2026-10-01T00:00:00Z</updated><link type="application/x-zim" href="https://example.org/wiki.zim.meta4" length="500"/></entry></feed>';
  const entry = parseWikipedia(xml).entries[0]; assert.equal(entry.edition, 'mini'); assert.equal(entry.seriesKey, 'kiwix:wikipedia_en_all:mini');
  const meta = `<metalink><file name="wiki.zim"><size>499</size><hash type="sha-256">${'a'.repeat(64)}</hash><pieces><hash>wrong</hash></pieces><url priority="2">https://b.example/wiki.zim</url><url priority="1">https://a.example/wiki.zim</url><url priority="0">http://insecure.example/wiki.zim</url></file></metalink>`;
  const parsed = parseMetalink(meta, 'wiki.zim'); assert.equal(parsed.mirrors[0], 'https://a.example/wiki.zim'); assert.equal(parsed.sha256, 'a'.repeat(64)); assert.equal(parsed.bytes, 499);
  assert.throws(() => parseMetalink(meta, 'other.zim'));
});
test('map region plans enforce bounds and a reasonable large-area detail limit', async () => {
  assert.throws(() => validateRegion({ bbox: [175, -20, -175, 20], zoom: 12 }));
  assert.throws(() => validateRegion({ bbox: [-180, -80, 180, 80], zoom: 15 }));
  assert.throws(() => validateRegion({ bbox: [0, 0, 1, 1], zoom: 99 }));
  const plan = mapPlan({ title: 'Monaco', bbox: [7.4, 43.7, 7.5, 43.8], zoom: 12 }, { url: 'https://example.org/map.pmtiles', date: '2026-10-10', version: '4.15' });
  assert.equal(plan.driver, 'pmtiles'); assert.match(plan.source.seriesKey, /^map:/);
  assert.equal(plan.title, 'Monaco'); assert.match(plan.description, /main streets/);
  assert.equal(mapPlan({ bbox: [7.4, 43.7, 7.5, 43.8], zoom: 14 }, { url: 'https://example.org/map.pmtiles', date: '2026-10-10', version: '4.15' }).title, 'My area');
  const { places } = await searchPlaces('Lisbon', { fetchImpl: async (url) => { assert.match(String(url), /nominatim\.openstreetmap\.org\/search\?q=Lisbon/); return new Response(JSON.stringify([
    { display_name: 'Lisbon, Portugal', addresstype: 'city', boundingbox: ['38.69', '38.80', '-9.23', '-9.09'] },
    { display_name: 'A fountain, Lisbon', type: 'fountain', boundingbox: ['38.7100', '38.7101', '-9.1400', '-9.1399'] },
    { display_name: 'Broken', boundingbox: ['x'] } ])); } });
  assert.deepEqual(places[0], { name: 'Lisbon', where: 'Portugal', kind: 'city', bbox: [-9.23, 38.69, -9.09, 38.8] });
  assert.equal(places.length, 2); assert.ok(places[1].bbox[2] - places[1].bbox[0] > 0.019, 'a single point gets room around it');
  await assert.rejects(searchPlaces('x'), /name of a place/);
});
test('publisher mismatch is rejected and nested podcast manifests rebuild', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-sources-')), archiveRoot = path.join(root, 'archive'); await mkdir(archiveRoot);
  const catalog = openCatalog(root);
  try {
    const temporaryPath = path.join(root, 'episode'); await writeFile(temporaryPath, 'audio');
    await assert.rejects(importFile({ catalog, archiveRoot, temporaryPath, filename: 'file.zim', expectedSha256: '0'.repeat(64) }), /checksum/); assert.equal(catalog.list().length, 0);
    const hash = createHash('sha256').update('audio').digest('hex');
    const result = await importFile({ catalog, archiveRoot, temporaryPath, filename: 'episode.mp3', type: 'audio', kind: 'podcast', collection: { title: 'A Show', id: '123' }, expectedSha256: hash });
    assert.match(result.item.path, /^Audio\/A Show--123\//); assert.equal(result.item.integrity, 'publisher-verified');
    assert.equal(rebuildCatalog(catalog, archiveRoot), 1);
  } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
});
test('batch queue drains beyond three jobs and provider identity deduplicates completed content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-queue-')); const catalog = openCatalog(root); let running = 0, maxRunning = 0;
  const manager = createDownloads({ catalog, root, archiveRoot: path.join(root, 'archive'), onChange: async () => {}, spacing: 0, drivers: { fixture: async ({ job, temporaryPath }) => { running++; maxRunning = Math.max(maxRunning, running); await new Promise(r => setTimeout(r, 40)); await writeFile(temporaryPath, job.title); running--; } } });
  try {
    const plans = Array.from({ length: 6 }, (_,i) => ({ title: `Episode ${i}`, url: 'https://example.org/file', filename: `${i}.txt`, driver: 'fixture', source: { seriesKey: 'show:123', version: String(i) } }));
    plans.forEach(p => manager.addPlan(p)); assert.equal(catalog.jobs().filter(j => j.status === 'queued').length, 3);
    const end = Date.now() + 4000;
    while (catalog.jobs().some(j => j.status !== 'complete') && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.equal(catalog.jobs().filter(j => j.status === 'complete').length, 6); assert.equal(maxRunning, 3);
    assert.equal(manager.addPlan(plans[0]).duplicate, true); assert.equal(catalog.jobs().length, 6);
  } finally { await manager.stop(); catalog.close(); await rm(root, { recursive: true, force: true }); }
});
