import { createHash } from 'node:crypto';
import { fetchJson, fetchText, httpUrl } from './http.js';
import { parseXml, array, text, plain } from './xml.js';
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const uniqueFeeds = shows => [...new Map(shows.map(show => [show.feedUrl, show])).values()];
export function podcastIndexHeaders(key, secret, now = Math.floor(Date.now() / 1000)) {
  return { 'X-Auth-Key': key, 'X-Auth-Date': String(now), Authorization: createHash('sha1').update(key + secret + now).digest('hex') };
}
export async function searchPodcasts(query, provider = 'apple', options = {}) {
  query = String(query || '').trim().slice(0, 150);
  if (query.length < 2) throw new Error('Enter at least two characters to search.');
  if (provider === 'podcastindex') {
    const key = process.env.PODCAST_INDEX_KEY, secret = process.env.PODCAST_INDEX_SECRET;
    if (!key || !secret) throw new Error('Podcast Index needs PODCAST_INDEX_KEY and PODCAST_INDEX_SECRET. Use Apple Podcasts or paste an RSS URL instead.');
    const data = await fetchJson(`https://api.podcastindex.org/api/1.0/search/byterm?${new URLSearchParams({ q: query, max: '24' })}`, { ...options, headers: podcastIndexHeaders(key, secret) });
    return { provider, shows: uniqueFeeds(array(data.feeds).filter(f => f.url).map(f => ({ id: String(f.id), title: f.title, author: f.author || '', feedUrl: httpUrl(f.url), description: plain(f.description) }))) };
  }
  if (provider !== 'apple') throw new Error('Unknown podcast directory.');
  const data = await fetchJson(`https://itunes.apple.com/search?${new URLSearchParams({ term: query, entity: 'podcast', media: 'podcast', limit: '24' })}`, options);
  return { provider, shows: uniqueFeeds(array(data.results).filter(f => f.feedUrl).map(f => ({ id: String(f.collectionId), title: f.collectionName, author: f.artistName || '', feedUrl: httpUrl(f.feedUrl), description: f.primaryGenreName || '' }))) };
}
export function parsePodcast(xml, feedUrl) {
  const doc = parseXml(xml), channel = doc.rss?.channel || doc.feed;
  if (!channel) throw new Error('This URL is not an RSS or Atom podcast feed.');
  const title = text(channel.title) || 'Untitled podcast', feedId = digest(feedUrl), seen = new Set();
  const episodes = array(channel.item || channel.entry).flatMap(item => {
    const enclosure = array(item.enclosure).find(e => e['@url']) || array(item.link).find(l => l['@rel'] === 'enclosure');
    if (!enclosure) return [];
    const mediaType = enclosure['@type'] || '';
    if (mediaType && !/^(audio|video)\//.test(mediaType) && mediaType !== 'application/octet-stream') return [];
    let url; try { url = httpUrl(enclosure['@url'] || enclosure['@href'], feedUrl); } catch { return []; }
    const guid = text(item.guid || item.id) || url;
    if (seen.has(guid)) return []; seen.add(guid);
    const date = new Date(text(item.pubDate || item.published || item.updated));
    const published = Number.isNaN(date.getTime()) ? null : date.toISOString();
    return [{ id: digest(guid), guid, title: text(item.title) || 'Untitled episode', description: plain(item.description || item.summary || item.content), url,
      bytes: Number(enclosure['@length']) || null, mediaType, published, duration: text(item.duration), showTitle: title, feedId, feedUrl }];
  }).sort((a,b) => (b.published || '').localeCompare(a.published || ''));
  return { id: feedId, title, author: text(channel.author?.name || channel.author), description: plain(channel.description || channel.subtitle), feedUrl, rights: text(channel.copyright || channel.rights) || 'Publisher retains rights; availability in a public RSS feed is not a redistribution license.', episodes };
}
export async function loadPodcast(feedUrl, options) {
  const result = await fetchText(httpUrl(feedUrl), options);
  return { ...parsePodcast(result.text, httpUrl(feedUrl)), resolvedFeedUrl: result.url, checkedAt: new Date().toISOString() };
}
export function podcastPlan(episode, rights) {
  const extensions = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4' };
  const urlExtension = new URL(episode.url).pathname.match(/\.(mp3|m4a|ogg|wav|flac|mp4|webm)$/i)?.[1]?.toLowerCase();
  const extension = urlExtension || extensions[episode.mediaType] || 'bin';
  return { url: episode.url, filename: `${episode.published?.slice(0,10) || 'undated'} - ${episode.title.replace(/[\\/]/g, '-')} - ${episode.id.slice(0,8)}.${extension}`,
    title: episode.title, description: episode.description, type: 'audio', kind: 'podcast', collection: { id: episode.feedId, title: episode.showTitle },
    rights, source: { adapter: 'podcasts', provider: episode.showTitle, url: episode.url, feedUrl: episode.feedUrl, episodeId: episode.guid, published: episode.published, seriesKey: `podcast:${episode.feedId}`, version: episode.id } };
}
