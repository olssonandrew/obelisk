import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../packages/core/agent.js";
import { assertCommitted, sourceAssetName } from "./release-lib.js";
/*
 * The complete corresponding source for a release build, published beside it as the
 * GPL asks: Obelisk at this commit, and every archive the bundled Wikipedia reader is
 * built from (desktop/zim/vendor/SOURCE.json), each checked against its pinned
 * checksum. Writes dist/Obelisk-<version>-source.tar.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
assertCommitted(root);
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const vendor = path.join(root, "desktop/zim/vendor");
const record = JSON.parse(await readFile(path.join(vendor, "SOURCE.json"), "utf8"));
const work = path.join(root, "dist", `source-${version}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(work, "wikipedia-reader"), { recursive: true });

// One server at a time, a few seconds apart; archives already here and intact are kept.
for (const [n, archive] of record.correspondingSource.archives.entries()) {
  const file = path.join(work, "wikipedia-reader", archive.name);
  if (sha256(await readFile(file).catch(() => "")) === archive.sha256) continue;
  if (n) await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(`Downloading ${archive.url}`);
  const response = await fetch(archive.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`${archive.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== archive.sha256) throw new Error(`${archive.name} doesn't match its pinned checksum.`);
  await writeFile(file, bytes);
}
await copyFile(path.join(vendor, "SOURCE.json"), path.join(work, "wikipedia-reader", "SOURCE.json"));
await copyFile(path.join(vendor, "LICENSE-GPL-3.0.txt"), path.join(work, "COPYING"));
execFileSync("git", ["archive", "--format=tar.gz", `--prefix=obelisk-${version}/`, "-o", path.join(work, `obelisk-${version}.tar.gz`), "HEAD"], { cwd: root });
await writeFile(
  path.join(work, "README.txt"),
  `Source for Obelisk ${version}

obelisk-${version}.tar.gz
  Obelisk at the commit these builds came from. Build it with npm ci, then
  npm run setup:maps and npm run package.

wikipedia-reader/
  The OpenZIM reader (libzim-wasm, GPL-3.0-or-later) is bundled unmodified from
  javascript-libzim ${record.version}. Its Makefile builds libzim-wasm.wasm with
  Emscripten from the other archives here. SOURCE.json lists each archive's
  original address and checksum.

The builds are distributed under GPL-3.0-or-later (COPYING). Obelisk's own code is
also available under the MIT license (LICENSE in the Obelisk archive).
`,
);
const out = path.join(root, "dist", sourceAssetName(version));
await rm(out, { force: true });
execFileSync("tar", ["-cf", out, "-C", work, "."]);
console.log(out);
