import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalog, rebuildCatalog } from '../packages/core/catalog.js';
import { importFile, safeFilename } from '../packages/core/archive.js';
import { directSource } from '../packages/sources/direct.js';
import { writeArchiveGuide } from '../packages/core/archive-guide.js';
import { classify } from '../packages/types/index.js';

test('cross-platform names cannot escape the archive or use Windows device names', () => {
  assert.equal(safeFilename('../../CON.txt'), '_CON.txt');
  assert.equal(safeFilename('folder\\NUL.pdf'), '_NUL.pdf');
  assert.equal(safeFilename('a:b?c*.txt '), 'a_b_c_.txt');
  assert.equal(safeFilename('..'), 'untitled');
  assert.equal(safeFilename('item.json'), 'content-item.json');
  assert.ok(Buffer.byteLength(safeFilename('🌲'.repeat(150) + '.pdf')) <= 160);
  assert.ok(safeFilename('a'.repeat(300) + '.pdf').endsWith('.pdf'));
});

test('source adapters reject unsupported schemes and credentials; handlers accept unknown files', () => {
  assert.throws(() => directSource.resolve({ url: 'file:///etc/passwd' }));
  assert.throws(() => directSource.resolve({ url: 'https://user:password@example.com/a' }));
  assert.equal(directSource.resolve({ url: 'https://example.com/a%20book.pdf' }).filename, 'a book.pdf');
  assert.deepEqual(classify('site.warc.gz'), { type: 'reference', kind: 'website', media: '' });
  assert.equal(classify('my.strangeformat').type, 'other');
  assert.equal(classify('Backup.TAR.GZ').kind, 'archive');
  assert.equal(classify('talk.m4b').kind, 'audiobook');
});

test('imports retain provenance, keep identical files as separate items, rebuild from manifests, and retain files after relocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-test-'));
  const archiveRoot = path.join(root, 'archive'); await mkdir(archiveRoot);
  const catalog = openCatalog(root);
  try {
    const tmp = path.join(root, 'input'); await writeFile(tmp, 'A portable library.');
    const result = await importFile({ catalog, archiveRoot, temporaryPath: tmp, filename: '../../notes.txt', title: '</script><script>alert(1)</script>', source: { adapter: 'import', provider: 'Test source' } });
    assert.equal(result.item.filename, 'notes.txt'); assert.equal(result.item.sha256.length, 64);
    assert.equal(result.item.offlineTested, false); assert.equal(result.item.source.provider, 'Test source');
    assert.equal(await readFile(path.join(archiveRoot, result.item.path), 'utf8'), 'A portable library.');
    await writeFile(tmp, 'A portable library.');
    // Identical bytes are allowed: someone may want the same file in two folders.
    const again = await importFile({ catalog, archiveRoot, temporaryPath: tmp, filename: 'different.txt' });
    assert.notEqual(again.item.id, result.item.id);
    assert.equal(catalog.list().length, 2);
    const concurrentA = path.join(root, 'concurrent-a'), concurrentB = path.join(root, 'concurrent-b');
    await writeFile(concurrentA, 'Metadata is not content.'); await writeFile(concurrentB, 'Metadata is not content.');
    const pair = await Promise.all([
      importFile({ catalog, archiveRoot, temporaryPath: concurrentA, filename: 'item.json' }),
      importFile({ catalog, archiveRoot, temporaryPath: concurrentB, filename: 'item.json' }),
    ]);
    assert.equal(new Set(pair.map(r => r.item.path)).size, 2, 'same name, separate item folders');
    assert.equal(await readFile(path.join(archiveRoot, pair[0].item.path), 'utf8'), 'Metadata is not content.');
    const moved = path.join(root, 'relocated'); await cp(archiveRoot, moved, { recursive: true });
    const rebuilt = openCatalog(path.join(root, 'rebuild'));
    try {
      assert.equal(rebuildCatalog(rebuilt, moved), 4);
      assert.deepEqual(rebuilt.list().sort((a,b) => a.id.localeCompare(b.id)), catalog.list().sort((a,b) => a.id.localeCompare(b.id)));
      assert.equal(await readFile(path.join(moved, result.item.path), 'utf8'), 'A portable library.');
    } finally { rebuilt.close(); }
  } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
});

test('a new library says where to find the app for opening it on another computer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'obelisk-guide-'));
  try {
    await writeArchiveGuide(root);
    const guide = await readFile(path.join(root, 'ABOUT THIS ARCHIVE.txt'), 'utf8');
    assert.match(guide, /OPENING THIS ARCHIVE ON ANOTHER COMPUTER\nObelisk keeps a copy of itself in Software\//);
    assert.match(guide, /without internet/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
