import { fetchText, httpUrl } from './http.js';
import { parseXml, array, text, plain } from './xml.js';
export const KIWIX_CATALOG = 'https://opds.library.kiwix.org/catalog/v2/entries';

export function parseWikipedia(xml, base = KIWIX_CATALOG) {
  const feed = parseXml(xml).feed;
  if (!feed) throw new Error('Kiwix returned an unexpected catalog.');
  const entries = array(feed.entry).flatMap(entry => {
    const link = array(entry.link).find(l => l['@type'] === 'application/x-zim' && l['@href']);
    if (!link) return [];
    const metadataUrl = httpUrl(link['@href'], base);
    return [{ id: text(entry.id), title: text(entry.title), description: plain(entry.summary), language: text(entry.language),
      edition: text(entry.flavour), version: text(entry.issued || entry.updated).slice(0, 10), name: text(entry.name),
      metadataUrl, bytes: Number(link['@length']) || null, articles: Number(entry.articleCount) || null,
      seriesKey: `kiwix:${text(entry.name)}:${text(entry.flavour)}` }];
  });
  return { entries, total: Number(feed.totalResults) || entries.length };
}
export async function wikipediaCatalog({ language = 'eng', query = '', start = 0 } = {}, options) {
  if (!/^[a-z]{3}$/.test(language)) throw new Error('Select a valid three-letter language code.');
  const url = new URL(KIWIX_CATALOG);
  url.search = new URLSearchParams({ category: 'wikipedia', lang: language, q: String(query).slice(0, 120), start: String(Math.max(0, Number(start) || 0)), count: '24' });
  const result = await fetchText(url.href, options);
  return { ...parseWikipedia(result.text, result.url), checkedAt: new Date().toISOString(), sourceUrl: url.href };
}
export function parseMetalink(xml, filename) {
  const files = array(parseXml(xml).metalink?.file);
  const file = files.find(f => f['@name'] === filename);
  if (!file) throw new Error('The mirror metadata does not describe the selected Wikipedia file.');
  const mirrors = array(file.url).filter(u => /^https:\/\//.test(text(u))).sort((a,b) => Number(a['@priority'] || 999) - Number(b['@priority'] || 999)).map(u => httpUrl(text(u)));
  const hash = array(file.hash).find(h => h['@type'] === 'sha-256');
  const sha256 = text(hash).toLowerCase();
  if (!mirrors.length || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('The mirror list is missing HTTPS links or a SHA-256 checksum.');
  return { mirrors, sha256, bytes: Number(file.size) || null };
}
export async function wikipediaPlan(entry, options) {
  const filename = new URL(entry.metadataUrl).pathname.split('/').pop().replace(/\.meta4$/, '');
  let url = entry.metadataUrl, expectedSha256, expectedBytes = entry.bytes, mirrors = [];
  if (url.endsWith('.meta4')) {
    const metadata = parseMetalink((await fetchText(url, options)).text, filename);
    mirrors = metadata.mirrors; url = mirrors[0]; expectedSha256 = metadata.sha256; expectedBytes = metadata.bytes;
  }
  return { url, filename, title: `${entry.title} · ${entry.language} · ${entry.edition} · ${entry.version}`, description: entry.description,
    expectedSha256, expectedBytes, type: 'reference', kind: 'encyclopedia',
    rights: 'Wikipedia content: retain its embedded attribution and applicable licenses. See the source edition.',
    source: { adapter: 'wikipedia', provider: 'Kiwix / Wikipedia', url: entry.metadataUrl, downloadUrl: url, mirrors, seriesKey: entry.seriesKey, version: entry.version, edition: entry.edition, language: entry.language } };
}
