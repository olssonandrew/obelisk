import { _electron as electron } from "playwright-core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Opens the packaged build in dist/ with a throwaway home and checks that its window
// comes up as this version. Release builds run it before they're uploaded.
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist", `Obelisk-${process.platform}-${process.arch}`);
const executablePath = {
  darwin: path.join(out, "Obelisk.app/Contents/MacOS/Obelisk"),
  win32: path.join(out, "Obelisk.exe"),
  linux: path.join(out, "Obelisk"),
}[process.platform];
const home = await mkdtemp(path.join(os.tmpdir(), "obelisk-launch-"));
// Setup already seen, so the demo library opens.
await writeFile(path.join(home, "desktop-settings.json"), JSON.stringify({ onboarded: true }));
const env = { ...process.env, OBELISK_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
// Offline, as on a drive taken somewhere without internet: every connection goes to a
// proxy that isn't there. An unzipped build's chrome-sandbox isn't owned by root, and
// CI can't fix that.
const args = ["--proxy-server=127.0.0.1:9", ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...process.argv.slice(2)];
const started = Date.now();
const app = await electron.launch({ executablePath, args, env, timeout: 60000 });
try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.locator(".primary-nav").waitFor();
  const opened = (Date.now() - started) / 1000;
  // Some CI machines (Linux, Intel Mac) have no GPU, so no WebGL, and a map can't be
  // drawn there. That says nothing about the build, so only that error is let through.
  const webgl = String(await app.evaluate(({ app }) => app.getGPUFeatureStatus().webgl)).startsWith("enabled");
  const errors = [];
  let skipped = 0;
  page.on("pageerror", (error) => {
    if (!webgl && /WebGL2? is required/.test(error.message)) skipped++;
    else errors.push(error.message);
  });
  const state = await page.evaluate(() => window.obelisk.state());
  if (state.appVersion !== version) throw new Error(`The build says it's ${state.appVersion}, not ${version}.`);
  // Each demo file opens in its reader or player.
  const demo = state.items.filter((item) => item.demo);
  if (!demo.length) throw new Error("The demo library is empty.");
  for (const item of demo) {
    await page.locator(".primary-nav [data-view=library]").click();
    await page.locator(`.file-card[data-id="${item.id}"]`).dblclick();
    await page.locator("#viewer:not([hidden])").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);
    if (errors.length) throw new Error(`Opening ${item.title} offline: ${errors.join("; ")}`);
  }
  console.log(`✓ Obelisk ${version} opens offline in ${opened.toFixed(1)} s on ${process.platform} ${process.arch}, and so do its ${demo.length} demo files.`);
  if (skipped) console.log(`  This machine has no WebGL, so ${skipped === 1 ? "a map" : `${skipped} maps`} couldn't be drawn.`);
  // A library of one's own gets a copy of the app, saved in the background.
  await page.evaluate((folder) => window.obelisk.setupCreate(folder), path.join(home, "Drive", "Obelisk"));
  const deadline = Date.now() + 180000;
  let copy;
  while (!copy && Date.now() < deadline) {
    const now = await page.evaluate(() => window.obelisk.state());
    if (now.appCopyError) throw new Error(`The build couldn't save its own copy: ${now.appCopyError}`);
    copy = now.items.find((item) => item.source?.adapter === "self-backup" && item.source.version === version);
    if (!copy) await page.waitForTimeout(1000);
  }
  if (!copy) throw new Error("The build didn't save its own copy into a new library.");
  console.log(`✓ It saves itself into a new library as ${copy.path}.`);
} finally {
  await app.close();
  await rm(home, { recursive: true, force: true });
}
