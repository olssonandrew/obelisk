/** Web pages: saved live, or as the Internet Archive's Wayback Machine recorded them. */
import { httpUrl } from './http.js';
import { safeFilename } from '../core/archive.js';

const WAYBACK = 'https://web.archive.org/web/';
export function pageUrl(value) {
  const text = String(value || '').trim();
  let url;
  try { url = new URL(httpUrl(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)); }
  catch { throw new Error('This is not the address of a web page.'); }
  // "notes" or "my page" are not addresses; a site has a dot in its name.
  if (/\s/.test(text) || !(/\./.test(url.hostname) || url.hostname === 'localhost' || url.hostname.startsWith('[')))
    throw new Error('This is not the address of a web page.');
  // A pasted Wayback link means "that snapshot of that page".
  const snapshot = /^\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(https?:\/\/.+)$/i.exec(url.pathname + url.search);
  if (url.hostname === 'web.archive.org' && snapshot) return { url: httpUrl(snapshot[2]), timestamp: snapshot[1] };
  url.hash = '';
  return { url: url.href };
}
/** `id_` asks the Wayback Machine for the bytes as first captured, with nothing rewritten or added. */
export const waybackRaw = (timestamp, url) => `${WAYBACK}${timestamp}id_/${url}`;
export function fromWayback(location) {
  const found = /^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(location || '');
  return found ? { timestamp: found[1], url: found[2] } : null;
}
export const snapshotDate = (timestamp) => {
  const t = String(timestamp).padEnd(14, '0');
  return new Date(`${t.slice(0, 4)}-${t.slice(4, 6) === '00' ? '01' : t.slice(4, 6)}-${t.slice(6, 8) === '00' ? '01' : t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`);
};
const WAYBACK_AGENT = 'Obelisk (personal offline archive)';
const pad = (digits, fill) => String(digits).replace(/\D/g, '').slice(0, 14).padEnd(14, fill);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The Internet Archive is a shared, donated service that drops clients who ask too
// fast, so lookups go one at a time with a pause between them.
let line = Promise.resolve();
const turn = () => { const mine = line.then(() => wait(250)); line = mine.catch(() => {}); return mine; };
const offline = () => new Error('The Wayback Machine could not be reached. Check your connection and try again.');
/**
 * The capture nearest a moment. Asking the Wayback Machine for a page at any timestamp
 * makes it redirect to the nearest capture it holds, whatever the spelling of the
 * address (with or without `www`, `http` or `https`). That is far more dependable than
 * its separate availability lookup, which misses many pages that are there.
 * Returns null when the page was never captured.
 */
export async function waybackNear(value, timestamp, { fetchImpl = fetch, probe } = {}) {
  // `probe` lets the desktop app ask over its browser connection (one shared HTTP/2
  // connection) instead of opening a new one per question, which the Archive refuses.
  probe ||= async (url) => {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': WAYBACK_AGENT }, signal: AbortSignal.timeout(20000) });
    return { status: response.status, location: response.headers.get('location') };
  };
  const page = pageUrl(value);
  const asked = pad(timestamp, '0'), at = waybackRaw(asked, page.url);
  let response;
  for (let attempt = 0; ; attempt++) {
    await turn();
    try { response = await probe(at); }
    catch { if (attempt >= 2) throw offline(); response = null; }
    if (response && (![429, 503].includes(response.status) || attempt >= 2)) break;
    await wait(4000 * (attempt + 1));
  }
  if ([429, 503].includes(response.status)) throw new Error('The Wayback Machine is busy. Wait a minute and try again.');
  const copy = (found) => ({ url: found.url, timestamp: found.timestamp, captured: snapshotDate(found.timestamp).toISOString() });
  if (response.status === 200) return copy({ url: page.url, timestamp: asked });
  // The first redirect names the nearest capture. Whatever that capture then does
  // (pages often redirected to `www`) is followed when the copy is actually saved.
  const target = response.status >= 300 && response.status < 400 && fromWayback(new URL(response.location || '', at).href);
  return target && /^\d{14}$/.test(target.timestamp) ? copy(target) : null;
}
/** The capture nearest a date (the most recent when no date is given). */
export async function waybackClosest(value, date = '', options) {
  const page = pageUrl(value), wanted = String(date || page.timestamp || '').replace(/\D/g, '').slice(0, 14);
  if (wanted && !/^(19|20)\d{2}/.test(wanted)) throw new Error('Choose a date after 1996.');
  // A bare day means the middle of that day; no date means "as late as possible".
  const found = await waybackNear(page.url, wanted ? (wanted.length === 8 ? wanted + '120000' : wanted) : '29991231235959', options);
  if (!found) throw new Error('The Wayback Machine has no copy of this page.');
  return found;
}
/** When the Wayback Machine first and last captured a page. */
export async function waybackRange(value, options) {
  const first = await waybackNear(value, '19900101000000', options);
  if (!first) throw new Error('The Wayback Machine has no copy of this page.');
  const last = (await waybackNear(first.url, '29991231235959', options)) || first;
  return { url: first.url, first, last };
}
const steps = { year: 12, half: 6, quarter: 3, month: 1 };
export const MAX_COPIES = 60;
/**
 * Copies of one page across time: one per year, half-year, quarter or month.
 * Nobody knows in advance which dates were captured, so each point in the span is
 * asked for its nearest capture and repeats are dropped. A page captured twice in
 * ten years yields two copies, not ten.
 */
export async function waybackSeries(value, { from, to, every = 'year' } = {}, options) {
  const months = steps[every];
  if (!months) throw new Error('Choose how often to take a copy.');
  const range = await waybackRange(value, options);
  const firstYear = Number(range.first.timestamp.slice(0, 4)), lastYear = Number(range.last.timestamp.slice(0, 4));
  const start = Math.max(firstYear, Number(from) || firstYear), end = Math.min(lastYear, Number(to) || lastYear);
  if (start > end) throw new Error(`The Wayback Machine’s copies of this page run from ${firstYear} to ${lastYear}.`);
  const points = [];
  for (let month = start * 12; month < (end + 1) * 12; month += months) {
    const middle = month + (months - 1) / 2, year = Math.floor(middle / 12), m = Math.floor(middle % 12) + 1;
    points.push(`${year}${String(m).padStart(2, '0')}${months === 12 ? '01' : '15'}120000`);
  }
  if (points.length > MAX_COPIES) throw new Error(`That is ${points.length} copies. Narrow the years or choose fewer per year (up to ${MAX_COPIES} at a time).`);
  const found = new Map([[range.first.timestamp, range.first], [range.last.timestamp, range.last]]);
  const inSpan = (copy) => { const year = Number(copy.timestamp.slice(0, 4)); return year >= start && year <= end; };
  let missed = 0;
  for (const point of points) {
    try { const copy = await waybackNear(range.url, point, options); if (copy) found.set(copy.timestamp, copy); }
    catch { missed++; }
  }
  // Two points a few seconds apart on the same day are the same visit by the crawler.
  const days = new Map();
  for (const copy of [...found.values()].filter(inSpan).sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
    if (!days.has(copy.timestamp.slice(0, 8))) days.set(copy.timestamp.slice(0, 8), copy);
  return { url: range.url, first: range.first, last: range.last, copies: [...days.values()], missed };
}
/** Other spellings worth trying when an address typed by hand does not answer. */
export function addressGuesses(value) {
  const url = new URL(pageUrl(value).url), out = [url.href];
  const swap = (change) => { const next = new URL(url.href); change(next); if (!out.includes(next.href)) out.push(next.href); };
  const www = (next) => { next.hostname = next.hostname.startsWith('www.') ? next.hostname.slice(4) : `www.${next.hostname}`; };
  if (!/^(\d+\.){3}\d+$|^\[|^localhost$/.test(url.hostname)) swap(www);
  if (url.protocol === 'https:' && !url.port) {
    swap((next) => { next.protocol = 'http:'; });
    if (out.length > 2) swap((next) => { next.protocol = 'http:'; www(next); });
  }
  return out;
}
export function webPlan({ url, timestamp }) {
  const page = pageUrl(url), host = new URL(page.url).hostname.replace(/^www\./, '');
  if (timestamp !== undefined && !/^\d{14}$/.test(String(timestamp))) throw new Error('Choose a saved copy first.');
  return {
    driver: 'web', url: page.url, snapshot: timestamp ? String(timestamp) : null,
    filename: safeFilename(`${host}.wacz`), title: host, type: 'reference', kind: 'website',
    rights: 'Rights remain with the publisher. Saved as a personal reference copy.',
    source: {
      adapter: 'web', provider: timestamp ? 'Wayback Machine' : host, url: page.url,
      ...(timestamp ? { snapshot: String(timestamp), seriesKey: `wayback:${page.url}`, version: String(timestamp) } : {}),
    },
  };
}
