import { spawn } from 'node:child_process';
import { access, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const mapToolPath = process.env.PMTILES_PATH || path.join(root, '.tools', process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles');
export async function mapToolAvailable() { return access(mapToolPath).then(() => true).catch(() => false); }
/** Asks the extractor how big a map would be, without downloading its tiles. */
export async function measureMap({ url, bbox, zoom }) {
  if (!await mapToolAvailable()) return null;
  const scratch = path.join(os.tmpdir(), `obelisk-measure-${randomUUID()}.pmtiles`);
  return new Promise((resolve) => {
    const child = spawn(mapToolPath, ['extract', url, scratch, `--bbox=${bbox.join(',')}`, `--maxzoom=${zoom}`, '--dry-run'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', c => { output = (output + c).slice(-4000); }); child.stderr.on('data', c => { output = (output + c).slice(-4000); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer); void rm(scratch, { force: true });
      const size = /archive size of ([\d.]+)\s*([kMGT]?)B/i.exec(output), tiles = /Region tiles (\d+)/.exec(output);
      resolve(size ? { bytes: Math.round(Number(size[1]) * 1000 ** ' kMGT'.indexOf(size[2] || ' ')), tiles: tiles ? Number(tiles[1]) : null } : null);
    });
  });
}
export async function extractMap({ job, temporaryPath, signal, update }) {
  if (!await mapToolAvailable()) throw new Error('Install the map extractor with npm run setup:maps, then resume this job.');
  await rm(temporaryPath, { force: true });
  const args = ['extract', job.url, temporaryPath, `--bbox=${job.bbox.join(',')}`, `--maxzoom=${job.zoom}`, '--download-threads=4'];
  update({ phase: 'Extracting regional tiles', resumable: false });
  await new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Paused')); return; }
    const child = spawn(mapToolPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', c => { tail = (tail + c).slice(-1500); }); child.stderr.on('data', c => { tail = (tail + c).slice(-1500); });
    const timer = setInterval(() => stat(temporaryPath).then(s => update({ bytes: s.size })).catch(() => {}), 1000);
    child.on('error', reject);
    child.on('close', code => { clearInterval(timer); signal.removeEventListener('abort', abort); code === 0 ? resolve() : reject(new Error(signal.aborted ? 'Paused' : `Map extraction failed: ${tail || `exit ${code}`}`)); });
  });
  update({ bytes: (await stat(temporaryPath)).size, phase: 'Recording checksum' });
}
