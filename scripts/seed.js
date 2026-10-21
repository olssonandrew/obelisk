import { mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalog, rebuildCatalog } from '../packages/core/catalog.js';
import { importFile } from '../packages/core/archive.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = path.resolve(process.env.OBELISK_HOME || path.join(projectRoot, 'demo'));
export async function seed(root = dataRoot) {
  const archiveRoot = path.join(root, 'archive');
  await mkdir(archiveRoot, { recursive: true });
  const catalog = openCatalog(root);
  try {
    rebuildCatalog(catalog, archiveRoot);
    const fixtures = [
      ['keeping-a-library.epub', 'Keeping a library', 'A short original book for the bundled EPUB reader.'],
      ['archive-checklist.pdf', 'An archive checklist', 'A printable two-page checklist for your offline library.'],
      ['motion-study.mp4', 'Motion study', 'A four-second original video for testing local playback.'],
      ['welcome.txt', 'A library that belongs to you', 'A short introduction to an archive built from ordinary files.'],
      ['field-notes.md', 'The field notebook', 'A few simple habits for observing, collecting, and returning.'],
      ['coast.svg', 'Along the Pacific', 'An original vector study in sea glass, stone, and afternoon light.'],
      ['dunes.svg', 'Forms of the desert', 'An original landscape study of shifting lines and warm earth.'],
    ];
    for (const [filename, title, description] of fixtures) {
      const id = `demo-${filename.split('.')[0]}`;
      if (catalog.get(id)) continue;
      const tmp = path.join(root, `${id}.tmp`);
      await copyFile(path.join(projectRoot, 'fixtures', filename), tmp);
      await importFile({ catalog, archiveRoot, temporaryPath: tmp, filename, title, description, id, demo: true,
        rights: 'CC0-1.0 · Original Obelisk demo material', source: { adapter: 'demo', provider: 'Obelisk originals' } });
    }
    if (!catalog.get('demo-audio')) {
      const sampleRate = 22050, seconds = 6, samples = sampleRate * seconds;
      const wav = Buffer.alloc(44 + samples * 2);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
      for (let n = 0; n < samples; n++) {
        const t = n / sampleRate, envelope = Math.min(t * 2, 1) * Math.max(0, 1 - t / seconds);
        wav.writeInt16LE(Math.round(1800 * envelope * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t))), 44 + n * 2);
      }
      const tmp = path.join(root, 'demo-audio.tmp'); await writeFile(tmp, wav);
      await importFile({ catalog, archiveRoot, temporaryPath: tmp, filename: 'quiet-interval.wav', title: 'A quiet interval', description: 'Six seconds of generated sound. A small test of offline listening.', id: 'demo-audio', demo: true,
        rights: 'CC0-1.0 · Original generated demo audio', source: { adapter: 'demo', provider: 'Obelisk originals' } });
    }
    return catalog.list().length;
  } finally { catalog.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Demo ready: ${await seed()} items in ${path.join(dataRoot, 'archive')}`);
}
