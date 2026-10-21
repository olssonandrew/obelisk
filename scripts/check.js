import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let failed = false;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'demo', '.git', 'dist', 'output', '.tools', '.playwright-cli', 'vendor'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs|mjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) failed = true;
    }
  }
}
walk(fileURLToPath(new URL('..', import.meta.url)));
process.exitCode = failed ? 1 : 0;
