import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile, copyFile, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = path.join(root, "desktop/map/vendor");
await mkdir(vendor, { recursive: true });
const worker = await build({
  entryPoints: [
    path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"),
  ],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
});
const main = await build({
  entryPoints: [
    path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl.mjs"),
  ],
  bundle: true,
  format: "iife",
  globalName: "maplibregl",
  minify: true,
  write: false,
});
await writeFile(
  path.join(vendor, "maplibre.js"),
  main.outputFiles[0].text +
    `\nmaplibregl.setWorkerUrl(URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0].text)}],{type:'text/javascript'})));\n`,
);
await copyFile(
  path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl.css"),
  path.join(vendor, "maplibre.css"),
);
await copyFile(
  path.join(root, "node_modules/pmtiles/dist/pmtiles.js"),
  path.join(vendor, "pmtiles.js"),
);
await copyFile(
  path.join(root, "node_modules/maplibre-gl/LICENSE.txt"),
  path.join(vendor, "maplibre-LICENSE.txt"),
);
await copyFile(
  path.join(root, "docs/PMTiles-LICENSE.txt"),
  path.join(vendor, "pmtiles-LICENSE.txt"),
);
// The cartography: Protomaps' own style for the tiles this app downloads.
await build({
  entryPoints: [path.join(root, "node_modules/@protomaps/basemaps/dist/esm/index.js")],
  bundle: true,
  format: "iife",
  globalName: "basemaps",
  minify: true,
  outfile: path.join(vendor, "basemaps.js"),
});
await writeFile(
  path.join(vendor, "basemaps-LICENSE.txt"),
  "@protomaps/basemaps: map style for Protomaps tiles. BSD-3-Clause.\nCopyright (c) Protomaps LLC and contributors.\nhttps://github.com/protomaps/basemaps/blob/main/LICENSE.md\n",
);
console.log("Local map viewer assets built. No runtime CDN requests.");

const readers = path.join(root, "desktop/renderer/reader/vendor");
await mkdir(readers, { recursive: true });
await build({
  entryPoints: [path.join(root, "desktop/renderer/reader/reader.js")],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: path.join(readers, "reader.js"),
});
await copyFile(
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs"),
  path.join(readers, "pdf.worker.mjs"),
);
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await cp(
    path.join(root, "node_modules/pdfjs-dist", folder),
    path.join(readers, folder),
    { recursive: true },
  );
for (const [pkg, license] of [
  ["pdfjs-dist", "LICENSE"],
  ["jszip", "LICENSE.markdown"],
  ["dompurify", "LICENSE"],
  ["marked", "LICENSE"],
])
  await copyFile(
    path.join(root, "node_modules", pkg, license),
    path.join(readers, pkg + "-LICENSE.txt"),
  );
console.log("Offline document readers built.");

await build({
  entryPoints: [path.join(root, "desktop/renderer/thumbnail-renderer.js")],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: path.join(readers, "thumbnails.js"),
});

await build({
  entryPoints: [path.join(root, "desktop/renderer/zim/reader.js")],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: path.join(root, "desktop/renderer/zim/reader.bundle.js"),
});

const zimVendor = path.join(root, "desktop/zim/vendor");
const zimSource = JSON.parse(
  await readFile(path.join(zimVendor, "SOURCE.json"), "utf8"),
);
for (const [name, expected] of Object.entries(zimSource.files)) {
  const hash = createHash("sha256")
    .update(await readFile(path.join(zimVendor, name)))
    .digest("hex");
  if (hash !== expected)
    throw new Error(`Bundled ZIM runtime checksum mismatch: ${name}`);
}
console.log("Bundled ZIM runtime verified.");
