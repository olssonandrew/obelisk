import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createWaczWriter, openWacz, surt } from '../packages/core/wacz.js';

test('a saved page round-trips through a standard WACZ', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'obelisk-wacz-')), file = path.join(dir, 'page.wacz');
  const writer = await createWaczWriter(file, { software: 'Obelisk test' });
  const html = Buffer.from('<title>Hello</title><img src="a.png?v=1">');
  writer.response({ url: 'https://example.com/', status: 200, statusText: 'OK', headers: [['Content-Type', 'text/html; charset=utf-8'], ['Content-Encoding', 'br'], ['X-Odd', 'a\r\nInjected: 1']], body: html });
  writer.response({ url: 'https://example.com/a.png?v=1', status: 200, headers: [['content-type', 'image/png']], body: Buffer.from([1, 2, 3, 0, 255]) });
  writer.response({ url: 'https://example.com/gone', status: 404, headers: [], body: Buffer.alloc(0) });
  writer.response({ url: 'https://example.com/', status: 500, headers: [], body: Buffer.from('second copy is ignored') });
  writer.resource({ url: 'urn:thumbnail:https://example.com/', mime: 'image/jpeg', body: Buffer.from('jpeg') });
  const done = await writer.finish({ url: 'https://example.com/', title: 'Hello', text: 'Hello there' });
  assert.equal(done.responses, 4);
  assert.deepEqual(await readdir(dir), ['page.wacz'], 'the working WARC is removed');

  // Another tool's ZIP reader sees the standard layout, stored without compression.
  const zip = await JSZip.loadAsync(await readFile(file));
  assert.deepEqual(Object.keys(zip.files).sort(), ['archive/data.warc.gz', 'datapackage.json', 'indexes/index.cdx', 'pages/pages.jsonl']);
  const pack = JSON.parse(await zip.file('datapackage.json').async('string'));
  assert.equal(pack.wacz_version, '1.1.1'); assert.equal(pack.mainPageURL, 'https://example.com/'); assert.equal(pack.resources.length, 3);
  const cdx = (await zip.file('indexes/index.cdx').async('string')).trim().split('\n');
  assert.match(cdx[0], /^com,example\)\/ \d{14} \{/);
  assert.deepEqual(cdx, [...cdx].sort());

  const saved = await openWacz(file);
  try {
    assert.equal(saved.pages[0].title, 'Hello'); assert.equal(saved.pages[0].text, 'Hello there');
    const page = await saved.get('https://example.com/#top');
    assert.equal(page.status, 200); assert.deepEqual(page.body, html);
    assert.ok(!page.headers.some(([k]) => /content-encoding|injected/i.test(k)), 'decoded bodies drop encoding headers; header values cannot add lines');
    assert.deepEqual((await saved.get('https://example.com/a.png?v=1')).body, Buffer.from([1, 2, 3, 0, 255]));
    assert.deepEqual((await saved.get('http://example.com/a.png?v=1')).body, Buffer.from([1, 2, 3, 0, 255]), 'http and https are the same page');
    assert.ok(await saved.get('https://example.com/a.png?v=20261013'), 'a changed cache-buster still finds the saved copy');
    assert.equal((await saved.get('https://example.com/gone')).status, 404);
    assert.equal(await saved.get('https://example.com/never'), null);
    assert.equal(await saved.get('https://other.example/a.png?v=1'), null);
    assert.equal((await saved.get('urn:thumbnail:https://example.com/')).body.toString(), 'jpeg');
  } finally { await saved.close(); }
});

test('index keys sort by site', () => {
  assert.equal(surt('https://News.Example.co.uk:8443/A/b?Q=1#x'), 'uk,co,example,news:8443)/a/b?q=1');
  assert.equal(surt('urn:thumbnail:https://example.com/'), 'urn:thumbnail:https://example.com/');
});

test('files that are not WACZ are refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'obelisk-wacz-')), file = path.join(dir, 'x.wacz');
  const zip = new JSZip(); zip.file('hello.txt', 'hi');
  await (await import('node:fs/promises')).writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(openWacz(file), /no index/);
  await (await import('node:fs/promises')).writeFile(file, 'not a zip');
  await assert.rejects(openWacz(file), /not a readable WACZ/);
});

test('page addresses, Wayback links and plans', async () => {
  const { pageUrl, webPlan, fromWayback, waybackRaw, waybackClosest, waybackSeries, addressGuesses, snapshotDate } = await import('../packages/sources/web.js');
  assert.deepEqual(pageUrl('example.com/a#part'), { url: 'https://example.com/a' });
  assert.deepEqual(pageUrl('https://web.archive.org/web/20190301120000/http://example.com/a?b=1'), { url: 'http://example.com/a?b=1', timestamp: '20190301120000' });
  for (const bad of ['', 'notes', 'not a url!!', 'example.com other.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com/']) assert.throws(() => pageUrl(bad), /address of a web page/);
  assert.deepEqual(pageUrl('http://localhost:8080/x'), { url: 'http://localhost:8080/x' });
  assert.equal(waybackRaw('20190301120000', 'http://example.com/'), 'https://web.archive.org/web/20190301120000id_/http://example.com/');
  assert.deepEqual(fromWayback('https://web.archive.org/web/20190302000000id_/https://www.example.com/'), { timestamp: '20190302000000', url: 'https://www.example.com/' });
  assert.equal(fromWayback('https://example.com/'), null);
  assert.equal(snapshotDate('20080603225319').toISOString(), '2008-06-03T22:53:19.000Z');
  const live = webPlan({ url: 'www.example.com/story' });
  assert.equal(live.driver, 'web'); assert.equal(live.type, 'reference'); assert.equal(live.kind, 'website'); assert.equal(live.filename, 'example.com.wacz');
  assert.equal(live.source.seriesKey, undefined, 'a page can be saved again later');
  const old = webPlan({ url: 'https://example.com/', timestamp: '20080603225319' });
  assert.equal(old.source.seriesKey, 'wayback:https://example.com/'); assert.equal(old.snapshot, '20080603225319');
  assert.throws(() => webPlan({ url: 'https://example.com/', timestamp: 'yesterday' }), /saved copy/);
  // The Archive answers any timestamp with a redirect to the nearest capture it holds.
  const asked = [];
  const probe = async (url) => {
    asked.push(url);
    const { timestamp, url: page } = fromWayback(url);
    if (/never/.test(page)) return { status: 404, location: null };
    const year = Math.min(2010, Math.max(2004, Number(timestamp.slice(0, 4))));
    // Captured once a year in 2004–2006 and 2010 only.
    const nearest = [2004, 2005, 2006, 2010].reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
    return { status: 302, location: `/web/${nearest}0615101010id_/http://www.example.com/` };
  };
  assert.deepEqual(await waybackClosest('example.com', '2005-06-01', { probe }), { url: 'http://www.example.com/', timestamp: '20050615101010', captured: '2005-06-15T10:10:10.000Z' });
  assert.match(asked[0], /\/web\/20050601120000id_\/https:\/\/example\.com\/$/);
  assert.equal((await waybackClosest('www.example.com', '', { probe })).timestamp, '20100615101010', 'no date means the latest');
  await assert.rejects(waybackClosest('never.example', '', { probe }), /no copy/);
  const series = await waybackSeries('example.com', { every: 'year' }, { probe });
  assert.deepEqual(series.copies.map((c) => c.timestamp.slice(0, 4)), ['2004', '2005', '2006', '2010'], 'years without a capture do not produce repeats');
  assert.equal(series.url, 'http://www.example.com/');
  assert.deepEqual((await waybackSeries('example.com', { from: 2005, to: 2006, every: 'half' }, { probe })).copies.map((c) => c.timestamp.slice(0, 4)), ['2005', '2006']);
  await assert.rejects(waybackSeries('example.com', { from: 1990, to: 2100, every: 'month' }, { probe }), /Narrow the years/);
  await assert.rejects(waybackSeries('example.com', { from: 2020, to: 2022 }, { probe }), /run from 2004 to 2010/);
  assert.deepEqual(addressGuesses('example.com/a'), ['https://example.com/a', 'https://www.example.com/a', 'http://example.com/a', 'http://www.example.com/a']);
  assert.deepEqual(addressGuesses('http://www.example.com/'), ['http://www.example.com/', 'http://example.com/']);
});
