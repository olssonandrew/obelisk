import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalog } from '../packages/core/catalog.js';
import { createDownloads } from '../packages/core/downloads.js';

async function until(condition, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await condition()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error(message);
}
for (const respectsRange of [true, false]) test(`paused downloads ${respectsRange ? 'resume' : 'restart safely when range is ignored'} without corrupting bytes`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-download-'));
  const archiveRoot = path.join(root, 'archive'); await mkdir(archiveRoot);
  const catalog = openCatalog(root), content = Buffer.alloc(512 * 1024, 'x'); let rangeRequested = false;
  const source = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || ''); rangeRequested ||= Boolean(match);
    const start = respectsRange && match ? Number(match[1]) : 0;
    res.writeHead(start ? 206 : 200, { 'Content-Length': content.length - start, ETag: '"sample-v1"', ...(start ? { 'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}) });
    let offset = start;
    const timer = setInterval(() => { res.write(content.subarray(offset, offset + 8192)); offset += 8192; if (offset >= content.length) { clearInterval(timer); res.end(); } }, 8);
    res.on('close', () => clearInterval(timer));
  }); source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const downloads = createDownloads({ catalog, root, archiveRoot, onChange: async () => {} });
  try {
    const job = downloads.add({ url: `http://127.0.0.1:${source.address().port}/sample.bin` });
    // Wait for persisted bytes, not a progress callback that can precede the disk write.
    await until(async () => (await stat(path.join(root, 'downloads', `${job.id}.part`)).catch(() => ({ size: 0 }))).size > 0, 'No persisted download progress');
    downloads.pause(job.id); await until(() => catalog.job(job.id).status === 'paused', 'Did not pause');
    assert.equal(catalog.list().length, 0);
    downloads.resume(job.id); await until(() => ['complete', 'failed'].includes(catalog.job(job.id).status), 'Did not finish');
    assert.equal(catalog.job(job.id).status, 'complete', catalog.job(job.id).error); assert.equal(rangeRequested, true);
    const item = catalog.list()[0]; assert.deepEqual(await readFile(path.join(archiveRoot, item.path)), content);
  } finally { await downloads.stop(); source.closeAllConnections(); await new Promise(r => source.close(r)); catalog.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP failures never create catalog items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-failure-'));
  const catalog = openCatalog(root);
  const source = http.createServer((req, res) => { res.writeHead(404); res.end('missing'); }); source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const downloads = createDownloads({ catalog, root, archiveRoot: path.join(root, 'archive'), onChange: async () => {} });
  try {
    const job = downloads.add({ url: `http://127.0.0.1:${source.address().port}/missing.pdf` });
    await until(() => catalog.job(job.id).status === 'failed', 'No failure recorded');
    assert.match(catalog.job(job.id).error, /404/); assert.equal(catalog.list().length, 0);
  } finally { await downloads.stop(); source.closeAllConnections(); await new Promise(r => source.close(r)); catalog.close(); await rm(root, { recursive: true, force: true }); }
});

test('a complete partial file left by a crash recovers from HTTP 416', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-recovery-'));
  const catalog = openCatalog(root), content = Buffer.from('Complete file.');
  const source = http.createServer((req, res) => {
    if (req.headers.range) { res.writeHead(416); res.end(); }
    else { res.writeHead(200, { ETag: '"v1"', 'Content-Length': content.length }); res.end(content); }
  }); source.listen(0, '127.0.0.1'); await once(source, 'listening');
  await mkdir(path.join(root, 'downloads')); await writeFile(path.join(root, 'downloads/recovery.part'), content);
  catalog.putJob({ id: 'recovery', url: `http://127.0.0.1:${source.address().port}/sample.txt`, filename: 'sample.txt', title: 'Recovered', status: 'downloading', validator: '"v1"', bytes: content.length });
  const downloads = createDownloads({ catalog, root, archiveRoot: path.join(root, 'archive'), onChange: async () => {} });
  try {
    assert.equal(catalog.job('recovery').status, 'paused'); downloads.resume('recovery');
    await until(() => ['complete', 'failed'].includes(catalog.job('recovery').status), 'Recovery did not finish');
    assert.equal(catalog.job('recovery').status, 'complete', catalog.job('recovery').error);
    assert.deepEqual(await readFile(path.join(root, 'archive', catalog.list()[0].path)), content);
  } finally { await downloads.stop(); source.closeAllConnections(); await new Promise(r => source.close(r)); catalog.close(); await rm(root, { recursive: true, force: true }); }
});
