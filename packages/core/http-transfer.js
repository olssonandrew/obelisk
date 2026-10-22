import { createWriteStream } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { directSource } from '../sources/direct.js';
import { sniff } from '../collections/format.js';
import { transferError, fromStatus, fromError } from './transfer-errors.js';

// Some servers refuse a request that names no program, or names a bare runtime.
import { USER_AGENT } from './agent.js';
export { USER_AGENT };

/**
 * Downloads `job.url` to `partial`, resuming when the source supports it. With
 * `job.formats`, the first bytes must be one of those families of file; a web page in
 * place of the file usually means the server blocked the download.
 */
export async function transferHttp({ job, temporaryPath: partial, signal, update: save, checkSpace, fetch: browserFetch }) {
  const host = (() => { try { return new URL(job.url).hostname; } catch { return null; } })();
  // The browser's connection follows redirects itself (it won't hand them back), and
  // only to web addresses; Node's is asked to stop at each one so it can be checked.
  const ask = async (url, headers, redirect) => {
    try {
      if (browserFetch) return await browserFetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal, redirect: 'follow' });
      return await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal, redirect });
    } catch (error) { if (signal.aborted) throw error; throw fromError(error, host); }
  };
  let offset = await stat(partial).then(s => s.size).catch(() => 0);
  // Resume only when a source validator identifies the previous representation.
  if (!job.validator && offset) { await rm(partial, { force: true }); offset = 0; }
  const headers = offset ? { Range: `bytes=${offset}-`, 'If-Range': job.validator, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' };
  let url = job.url, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await ask(url, headers, 'manual');
    if (browserFetch) { url = directSource.resolve({ url: response.url || url }).url; break; }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw transferError('The source sent too many redirects.', 'gone', { host });
    url = directSource.resolve({ url: new URL(location, url).href }).url;
  }
  if (response.status === 416 && offset) {
    // A crash may leave a complete partial file, or a source may have shrunk.
    // A fresh transfer is safer than repeatedly requesting an invalid range.
    await response.body?.cancel(); await rm(partial, { force: true }); offset = 0;
    response = await ask(url, { 'Accept-Encoding': 'identity' }, 'error');
  }
  if (!response.ok) { await response.body?.cancel(); throw fromStatus(response.status, response.headers, host); }
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
    await response.body?.cancel(); throw new Error('Source ignored the uncompressed transfer request; resumable download is unavailable.');
  }
  const validator = response.headers.get('etag')?.replace(/^W\/.*$/, '') || response.headers.get('last-modified');
  let total;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!offset || !range || Number(range[1]) !== offset || validator !== job.validator) {
      await response.body?.cancel(); throw new Error('Source returned an inconsistent resume response. Start a new download.');
    }
    total = Number(range[3]);
  } else {
    offset = 0;
    total = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null;
  }
  if (total) await checkSpace?.(total - offset);
  // A server that doesn't say how big the file is leaves the size the collection gave.
  save({ bytes: offset, total: total ?? job.total ?? null, validator, finalUrl: url, resumable: Boolean(validator) });
  let lastSave = 0, head = offset || !job.formats ? null : Buffer.alloc(0);
  // The first bytes say what the file really is.
  const identify = () => {
    const found = sniff(head);
    head = null;
    if (found === 'html') return transferError(`${host} sent a web page instead of the file. It may be blocking downloads.`, 'refused', { host });
    if (!job.formats.includes(found)) return transferError(`The file isn't the kind this collection holds${found ? ` (it's ${found.toUpperCase()})` : ''}.`, 'changed', { host });
    return null;
  };
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      if (head) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 64) { const problem = identify(); if (problem) return callback(problem); }
      }
      job.bytes += chunk.length;
      if (Date.now() - lastSave > 250) { save({}); lastSave = Date.now(); }
      callback(null, chunk);
    },
    flush(callback) { callback(head ? identify() : null); },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw fromError(error, host);
  }
  // A connection that ends early is worth another try; it resumes where it stopped.
  if (total !== null && job.bytes !== total) throw transferError(`The connection to ${host} ended early.`, 'offline', { host });
}
