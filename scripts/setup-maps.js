import { mkdir, writeFile, mkdtemp, rm, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const platform = { darwin: 'Darwin', linux: 'Linux', win32: 'Windows' }[process.platform];
const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!platform || !arch) throw new Error('This OS/CPU combination needs a manually installed PMTiles binary. Set PMTILES_PATH.');
// CI shares its address with many others; its token keeps GitHub's API from refusing.
const response = await fetch('https://api.github.com/repos/protomaps/go-pmtiles/releases/tags/v1.31.2', { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}, signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Could not read release metadata: HTTP ${response.status}`);
const release = await response.json();
const asset = release.assets.find(a => a.name.includes(`${platform}_${arch}.`));
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Release asset or publisher checksum unavailable.');
console.log(`Downloading official ${asset.name} (${Math.round(asset.size / 1024 ** 2)} MB)…`);
const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
if (!download.ok) throw new Error(`Download failed: HTTP ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('Map tool checksum mismatch.');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'obelisk-map-tool-'));
try {
  const archive = path.join(tmp, asset.name); await writeFile(archive, bytes);
  // BSD tar on macOS/Windows supports ZIP; GNU tar handles Linux tar.gz releases.
  execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' });
  const executable = process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles';
  await mkdir(path.join(root, '.tools'), { recursive: true });
  await copyFile(path.join(tmp, executable), path.join(root, '.tools', executable));
  await chmod(path.join(root, '.tools', executable), 0o755);
  await writeFile(path.join(root, '.tools', 'release.json'), JSON.stringify({ version: release.tag_name, asset: asset.name, digest: asset.digest, source: release.html_url }, null, 2));
  console.log('Map extractor installed in .tools/. No system-wide installation.');
} finally { await rm(tmp, { recursive: true, force: true }); }
