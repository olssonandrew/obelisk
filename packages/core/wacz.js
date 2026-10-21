/**
 * Saved web pages are WACZ files: a ZIP holding a WARC (the ISO 28500 web archive
 * format: every response exactly as it was received), an index of where each
 * response sits, and a list of pages. Any WACZ reader can open them without this app.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import zlib from 'node:zlib';

const CRLF = '\r\n';
const stamp = (date) => date.toISOString().replace(/\D/g, '').slice(0, 14);
const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const cleanHeader = (value) => String(value).replace(/[\r\n]+/g, ' ');

/** Sort-friendly URL key: host reversed, then path. `https://a.example.com/x` → `com,example,a)/x`. */
export function surt(value) {
  let url;
  try { url = new URL(value); } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol)) return value;
  const host = url.hostname.toLowerCase().split('.').reverse().join(',');
  return `${host}${url.port ? ':' + url.port : ''})${url.pathname}${url.search}`.toLowerCase();
}

function zipTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
function zipHeader(central, entry, when) {
  const name = Buffer.from(entry.name), head = Buffer.alloc(central ? 46 : 30);
  let at = head.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, 0);
  if (central) at = head.writeUInt16LE(20, at);
  at = head.writeUInt16LE(20, at);
  at = head.writeUInt16LE(0x0800, at); // names are UTF-8
  at = head.writeUInt16LE(0, at); // stored, so a reader can seek straight to a record
  at = head.writeUInt16LE(when.time, at);
  at = head.writeUInt16LE(when.date, at);
  at = head.writeUInt32LE(entry.crc, at);
  at = head.writeUInt32LE(entry.size, at);
  at = head.writeUInt32LE(entry.size, at);
  at = head.writeUInt16LE(name.length, at);
  if (central) head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

/** Records responses as they arrive, then packages them. Calls may overlap; writes do not. */
export async function createWaczWriter(filename, { software = 'Obelisk' } = {}) {
  const warcPath = `${filename}.warc.gz`, warc = await open(warcPath, 'w');
  const index = [], seen = new Set();
  let offset = 0, crc = 0, queue = Promise.resolve(), closed = false;
  const hash = createHash('sha256');

  function record(type, fields, block) {
    const head = [`WARC/1.1`, `WARC-Type: ${type}`, `WARC-Record-ID: <urn:uuid:${randomUUID()}>`,
      ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${cleanHeader(v)}`),
      `Content-Length: ${block.length}`, '', ''].join(CRLF);
    // Each record is its own gzip member, which is what makes random access possible.
    const member = zlib.gzipSync(Buffer.concat([Buffer.from(head), block, Buffer.from(CRLF + CRLF)]));
    const entry = { offset, length: member.length };
    queue = queue.then(async () => {
      await warc.write(member);
      crc = zlib.crc32(member, crc); hash.update(member);
    });
    offset += member.length;
    return entry;
  }
  record('warcinfo', { 'WARC-Date': new Date().toISOString(), 'WARC-Filename': 'data.warc.gz', 'Content-Type': 'application/warc-fields' },
    Buffer.from(`software: ${cleanHeader(software)}${CRLF}format: WARC File Format 1.1${CRLF}`));

  return {
    get bytes() { return offset; },
    get count() { return index.length; },
    has: (url) => seen.has(url),
    /** One HTTP response. `body` is stored decoded; encoding headers are dropped to match. */
    response({ url, date = new Date(), status, statusText = '', headers = [], body = Buffer.alloc(0) }) {
      if (closed || seen.has(url)) return;
      seen.add(url);
      const kept = headers.filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k));
      const http = [`HTTP/1.1 ${status} ${cleanHeader(statusText) || 'OK'}`,
        ...kept.map(([k, v]) => `${cleanHeader(k)}: ${cleanHeader(v)}`), `Content-Length: ${body.length}`, '', ''].join(CRLF);
      const digest = sha256(body), mime = (kept.find(([k]) => /^content-type$/i.test(k))?.[1] || '').split(';')[0].trim();
      const entry = record('response', { 'WARC-Date': date.toISOString(), 'WARC-Target-URI': url,
        'Content-Type': 'application/http; msgtype=response', 'WARC-Payload-Digest': digest }, Buffer.concat([Buffer.from(http), body]));
      index.push({ url, date, mime, status: String(status), digest, ...entry });
    },
    /** A file that was not an HTTP response, such as the screenshot (`urn:thumbnail:<page>`). */
    resource({ url, date = new Date(), mime, body }) {
      if (closed || seen.has(url)) return;
      seen.add(url);
      const digest = sha256(body);
      const entry = record('resource', { 'WARC-Date': date.toISOString(), 'WARC-Target-URI': url, 'Content-Type': mime, 'WARC-Payload-Digest': digest }, body);
      index.push({ url, date, mime, status: '200', digest, ...entry });
    },
    async discard() { closed = true; await queue.catch(() => {}); await warc.close().catch(() => {}); await rm(warcPath, { force: true }); },
    async finish({ url, title = '', text = '', date = new Date(), extra = {} }) {
      closed = true;
      await queue; await warc.close();
      const out = await open(filename, 'w'), entries = [], when = zipTime(date);
      let position = 0;
      const write = async (data) => { await out.write(data); position += data.length; };
      try {
        const add = async (name, data) => {
          const entry = { name, crc: zlib.crc32(data), size: data.length, offset: position, hash: sha256(data) };
          await write(zipHeader(false, entry, when)); await write(data); entries.push(entry);
        };
        const big = { name: 'archive/data.warc.gz', crc, size: offset, offset: 0, hash: `sha256:${hash.digest('hex')}` };
        await write(zipHeader(false, big, when));
        for await (const chunk of createReadStream(warcPath)) await write(chunk);
        entries.push(big);
        const lines = index.map((r) => `${surt(r.url)} ${stamp(r.date)} ${JSON.stringify({ url: r.url, mime: r.mime, status: r.status, digest: r.digest, length: String(r.length), offset: String(r.offset), filename: 'data.warc.gz' })}`).sort();
        await add('indexes/index.cdx', Buffer.from(lines.join('\n') + '\n'));
        await add('pages/pages.jsonl', Buffer.from([
          JSON.stringify({ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }),
          JSON.stringify({ id: randomUUID(), url, title, ts: date.toISOString(), ...(text ? { text } : {}) }),
        ].join('\n') + '\n'));
        await add('datapackage.json', Buffer.from(JSON.stringify({
          profile: 'data-package', wacz_version: '1.1.1', software, created: new Date().toISOString(),
          title: title || url, mainPageURL: url, mainPageDate: date.toISOString(), ...extra,
          resources: entries.map((e) => ({ name: e.name.split('/').pop(), path: e.name, hash: e.hash, bytes: e.size })),
        }, null, 2)));
        const start = position;
        for (const entry of entries) await write(zipHeader(true, entry, when));
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(position - start, 12); end.writeUInt32LE(start, 16);
        await write(end);
      } finally { await out.close(); await rm(warcPath, { force: true }); }
      return { responses: index.length, bytes: position };
    },
  };
}

async function readAt(file, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}
async function zipEntries(file, size) {
  const tail = await readAt(file, Math.max(0, size - 65558), Math.min(size, 65558));
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error('This is not a readable WACZ file.');
  let count = tail.readUInt16LE(at + 10), length = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16);
  if (start === 0xffffffff || count === 0xffff) {
    const locator = at - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('This WACZ file is damaged.');
    const big = await readAt(file, Number(tail.readBigUInt64LE(locator + 8)), 56);
    count = Number(big.readBigUInt64LE(32)); length = Number(big.readBigUInt64LE(40)); start = Number(big.readBigUInt64LE(48));
  }
  if (length > 64 * 1024 ** 2) throw new Error('This WACZ file has too many parts to open here.');
  const directory = await readAt(file, start, length), entries = new Map();
  for (let p = 0, n = 0; n < count && p + 46 <= directory.length; n++) {
    if (directory.readUInt32LE(p) !== 0x02014b50) break;
    const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
    const entry = { method: directory.readUInt16LE(p + 10), packed: directory.readUInt32LE(p + 20), size: directory.readUInt32LE(p + 24), header: directory.readUInt32LE(p + 42) };
    const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
    for (let x = p + 46 + nameLength, stop = x + extraLength; x + 4 <= stop;) {
      const id = directory.readUInt16LE(x), len = directory.readUInt16LE(x + 2);
      if (id === 1) {
        let field = x + 4;
        for (const key of ['size', 'packed', 'header'])
          if (entry[key] === 0xffffffff && field + 8 <= x + 4 + len) { entry[key] = Number(directory.readBigUInt64LE(field)); field += 8; }
      }
      x += 4 + len;
    }
    entries.set(name, entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  for (const entry of entries.values()) entry.start = null;
  return entries;
}
function parseHeaders(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }).filter(([k]) => k);
}
function split(buffer) {
  let at = buffer.indexOf('\r\n\r\n'), gap = 4;
  if (at < 0) { at = buffer.indexOf('\n\n'); gap = 2; }
  return at < 0 ? [buffer.toString('latin1'), Buffer.alloc(0)] : [buffer.toString('latin1', 0, at), buffer.subarray(at + gap)];
}
function unchunk(body) {
  const parts = [];
  for (let p = 0; p < body.length;) {
    const line = body.indexOf('\r\n', p);
    if (line < 0) break;
    const size = parseInt(body.toString('latin1', p, line), 16);
    if (!(size > 0)) break;
    parts.push(body.subarray(line + 2, line + 2 + size)); p = line + 2 + size + 2;
  }
  return Buffer.concat(parts);
}
const decoders = { gzip: zlib.gunzipSync, 'x-gzip': zlib.gunzipSync, deflate: (b) => { try { return zlib.inflateSync(b); } catch { return zlib.inflateRawSync(b); } }, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync };

/** Opens a WACZ for reading. Nothing is unpacked; responses are read where they lie. */
export async function openWacz(filename) {
  const file = await open(filename, 'r');
  try {
    const { size } = await file.stat(), entries = await zipEntries(file, size);
    async function dataStart(entry) {
      if (entry.start === null) {
        const local = await readAt(file, entry.header, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('This WACZ file is damaged.');
        entry.start = entry.header + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      }
      return entry.start;
    }
    async function whole(name, limit = 256 * 1024 ** 2) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.packed > limit || entry.size > limit) throw new Error('Part of this WACZ file is too large to open here.');
      const raw = await readAt(file, await dataStart(entry), entry.packed);
      if (entry.method === 0) return raw;
      if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: limit });
      throw new Error('This WACZ file uses compression this reader does not support.');
    }
    const records = new Map(), loose = new Map(), names = [...entries.keys()];
    for (const name of names.filter((n) => /^indexes\/[^/]+\.(cdxj?|cdxj?\.gz)$/.test(n))) {
      let data = await whole(name);
      if (name.endsWith('.gz')) data = zlib.gunzipSync(data, { maxOutputLength: 512 * 1024 ** 2 });
      for (const line of data.toString('utf8').split('\n')) {
        const brace = line.indexOf('{');
        if (brace < 0) continue;
        let fields; try { fields = JSON.parse(line.slice(brace)); } catch { continue; }
        if (!fields.url || fields.offset === undefined) continue;
        const ts = line.slice(0, brace).trim().split(' ').pop();
        const next = { url: fields.url, mime: fields.mime || '', status: Number(fields.status) || 200, offset: Number(fields.offset), length: Number(fields.length), filename: fields.filename, ts };
        const key = next.url.split('#')[0], previous = records.get(key);
        // Prefer a real page over a redirect or error, then the newest capture.
        const good = (r) => r.status >= 200 && r.status < 300;
        if (!previous || (good(next) && !good(previous)) || (good(next) === good(previous) && next.ts > previous.ts)) records.set(key, next);
      }
    }
    if (!records.size) throw new Error('This WACZ file has no index this reader understands.');
    for (const [url, entry] of records) {
      try { const u = new URL(url); if (u.search) { const key = u.host + u.pathname; if (!loose.has(key)) loose.set(key, entry); } } catch {}
    }
    const pages = [];
    for (const name of names.filter((n) => /^pages\/[^/]+\.jsonl$/.test(n))) {
      for (const line of ((await whole(name, 64 * 1024 ** 2)) || '').toString('utf8').split('\n')) {
        try { const page = JSON.parse(line); if (page.url) pages.push({ url: page.url, title: page.title || '', ts: page.ts || '', text: page.text || '' }); } catch {}
      }
    }
    let info = {};
    try { info = JSON.parse((await whole('datapackage.json', 8 * 1024 ** 2)).toString('utf8')); } catch {}

    async function read(entry, depth = 0) {
      const container = entries.get(`archive/${entry.filename}`);
      if (!container) throw new Error('This saved response is missing.');
      if (container.method !== 0) throw new Error('This WACZ file is packed in a way that cannot be read in place.');
      if (!(entry.length > 0) || entry.length > 512 * 1024 ** 2) throw new Error('This saved response cannot be read.');
      let raw = await readAt(file, (await dataStart(container)) + entry.offset, entry.length);
      if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw, { maxOutputLength: 512 * 1024 ** 2 });
      const [warcHead, rest] = split(raw), warc = new Map(parseHeaders(warcHead.split(/\r?\n/).slice(1).join('\n')).map(([k, v]) => [k.toLowerCase(), v]));
      const block = rest.subarray(0, Number(warc.get('content-length')) || rest.length), type = warc.get('warc-type');
      if (type === 'revisit' && depth < 2) {
        const original = records.get(warc.get('warc-refers-to-target-uri'));
        if (original && original !== entry) {
          const [head] = split(block), lines = head.split(/\r?\n/), found = await read(original, depth + 1);
          return { ...found, status: Number(lines[0].split(' ')[1]) || found.status, headers: parseHeaders(lines.slice(1).join('\n')) };
        }
      }
      if (type !== 'response') return { status: 200, headers: [['Content-Type', warc.get('content-type') || entry.mime]], body: block, date: warc.get('warc-date') };
      const [head, payload] = split(block), lines = head.split(/\r?\n/);
      let headers = parseHeaders(lines.slice(1).join('\n')), body = payload;
      const value = (name) => headers.find(([k]) => k.toLowerCase() === name)?.[1] || '';
      try {
        if (/chunked/i.test(value('transfer-encoding'))) body = unchunk(body);
        for (const coding of value('content-encoding').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean).reverse())
          if (decoders[coding]) body = decoders[coding](body);
      } catch { /* Stored already decoded: common, and the bytes are usable as they are. */ }
      headers = headers.filter(([k]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(k));
      return { status: Number(lines[0].split(' ')[1]) || 200, headers, body, date: warc.get('warc-date') };
    }
    function find(value) {
      const url = String(value).split('#')[0], swapped = url.startsWith('https:') ? 'http:' + url.slice(6) : url.startsWith('http:') ? 'https:' + url.slice(5) : null;
      let entry = records.get(url) || (swapped && records.get(swapped));
      // Pages often add a random or time-based query; the saved copy of that address still fits.
      if (!entry) { try { const u = new URL(url); if (u.search) entry = loose.get(u.host + u.pathname); } catch {} }
      return entry || null;
    }
    return {
      pages, info, size: records.size,
      urls: () => [...records.keys()],
      has: (url) => Boolean(find(url)),
      async get(url) { const entry = find(url); return entry ? read(entry) : null; },
      close: () => file.close(),
    };
  } catch (error) { await file.close(); throw error; }
}
