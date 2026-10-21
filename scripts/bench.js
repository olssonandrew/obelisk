// Opens the desktop app on a large generated archive and measures the library:
// startup, state size, rendering and scrolling. Nothing touches the demo archive.
//   npm run bench -- [items=20000] [photos=300]
// PROFILE=1 prints where search time goes; SHOT=path saves screenshots.
import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, link, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const total = Number(process.argv[2] || 20000),
  photos = Math.min(total, Number(process.argv[3] || 300));
const home = await mkdtemp(path.join(os.tmpdir(), "obelisk-bench-"));
const archive = path.join(home, "Big archive");

// A few camera-sized photos, linked many times so the archive stays small on disk.
const sources = [];
for (let i = 0; i < 4; i++) {
  const file = path.join(home, `source-${i}.jpg`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=4032x3024:rate=1,noise=alls=${20 + i * 10}:allf=t`, "-frames:v", "1", "-q:v", "3", file]);
  sources.push(file);
}
const started = Date.now();
for (let n = 0; n < total; n++) {
  const id = randomUUID(),
    photo = n < photos,
    filename = photo ? `IMG_${String(n).padStart(5, "0")}.jpg` : `note-${n}.txt`,
    shelf = photo ? "Images" : "Documents",
    folder = path.join(archive, shelf, `${filename}--${id}`);
  await mkdir(folder, { recursive: true });
  if (photo) await link(sources[n % sources.length], path.join(folder, filename));
  else await writeFile(path.join(folder, filename), `Note ${n}`);
  await writeFile(path.join(folder, "item.json"), JSON.stringify({
    schemaVersion: 1, id, title: filename.replace(/\.[^.]+$/, ""), description: "",
    type: photo ? "image" : "document", kind: photo ? "photo" : "note", filename,
    path: `${shelf}/${filename}--${id}/${filename}`, bytes: photo ? 3_000_000 : 8,
    sha256: createHash("sha256").update(id).digest("hex"),
    acquiredAt: new Date(Date.now() - n * 60000).toISOString(),
    source: { adapter: "import", provider: "Local import" }, tags: n % 7 ? [] : ["sample"],
  }));
}
// Marked as a library, as one made by the app would be.
await mkdir(path.join(archive, ".obelisk"), { recursive: true });
await writeFile(path.join(home, "desktop-settings.json"), JSON.stringify({ archiveRoot: archive, onboarded: true }));
console.log(`Generated ${total} items (${photos} photos) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const env = { ...process.env, OBELISK_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const launched = Date.now();
const app = await electron.launch({ args: [root], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  await page.locator(".file-card").first().waitFor();
  console.log(`First cards after ${((Date.now() - launched) / 1000).toFixed(1)}s`);
  const rss = () => app.evaluate(() => Math.round(process.memoryUsage().rss / 1048576));
  console.log(`Main process at first cards: ${await rss()} MB`);
  await page.waitForTimeout(8000);
  console.log(`Main process 8s later (background work done): ${await rss()} MB`);
  const ipc = await page.evaluate(async () => {
    const t = performance.now(), s = await window.obelisk.state();
    return { ms: Math.round(performance.now() - t), mb: (JSON.stringify(s).length / 1e6).toFixed(1) };
  });
  console.log(`state(): ${ipc.ms} ms, ${ipc.mb} MB`);
  const poll = await page.evaluate(async () => {
    const { revision } = await window.obelisk.state(), t = performance.now();
    const s = await window.obelisk.state(revision);
    return { ms: Math.round(performance.now() - t), kb: (JSON.stringify(s).length / 1e3).toFixed(0) };
  });
  console.log(`state(unchanged): ${poll.ms} ms, ${poll.kb} KB`);
  const search = await page.evaluate(async () => {
    const box = document.querySelector("#search"), t = performance.now();
    box.value = "note 4"; box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
    const first = performance.now() - t, u = performance.now();
    box.value = "note 42"; box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
    const second = performance.now() - u;
    box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true }));
    return { first: Math.round(first), second: Math.round(second) };
  });
  console.log(`Search keystroke: ${search.first} ms first, ${search.second} ms after`);
  if (process.env.PROFILE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.start");
    await page.evaluate(async () => {
      const box = document.querySelector("#search");
      for (const q of ["n", "no", "not", "note", "note 1", "note 12", ""]) { box.value = q; box.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(requestAnimationFrame); }
    });
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map(), nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => { const f = nodes.get(id).callFrame, k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
    console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `  ${(v / 1000).toFixed(0)} ms ${k}`).join("\n"));
  }
  // How long the page is unresponsive across a few refresh cycles while idle.
  const idle = await page.evaluate(() => new Promise((resolve) => {
    let last = performance.now(), worst = 0, long = 0;
    const stop = last + 6000;
    const tick = (now) => {
      const gap = now - last; last = now;
      worst = Math.max(worst, gap); if (gap > 50) long++;
      if (now < stop) requestAnimationFrame(tick); else resolve({ worst: Math.round(worst), long });
    };
    requestAnimationFrame(tick);
  }));
  console.log(`Idle 6s: worst frame ${idle.worst} ms, ${idle.long} frames over 50 ms`);
  // Fling through the photos and the rest, as fast as the wheel goes.
  const scroll = await page.evaluate(() => new Promise((resolve) => {
    const area = document.querySelector("#file-area");
    let last = performance.now(), worst = 0, long = 0, frames = 0;
    const end = performance.now() + 5000;
    const tick = (now) => {
      const gap = now - last; last = now; frames++;
      worst = Math.max(worst, gap); if (gap > 50) long++;
      area.scrollTop += 600;
      if (area.scrollTop + area.clientHeight >= area.scrollHeight - 1) area.scrollTop = 0;
      if (now < end) requestAnimationFrame(tick);
      else resolve({ worst: Math.round(worst), long, fps: Math.round(frames / 5), cards: document.querySelectorAll(".file-card").length });
    };
    requestAnimationFrame(tick);
  }));
  console.log(`Scroll 5s: ${scroll.fps} fps, worst frame ${scroll.worst} ms, ${scroll.long} frames over 50 ms, ${scroll.cards} cards in the page`);
  const sorted = await page.evaluate(async () => {
    const sort = document.querySelector("#sort"), t = performance.now();
    sort.value = "title"; sort.dispatchEvent(new Event("change"));
    await new Promise(requestAnimationFrame);
    const ms = performance.now() - t;
    sort.value = "recent"; sort.dispatchEvent(new Event("change"));
    return Math.round(ms);
  });
  console.log(`Sort by name: ${sorted} ms`);
  const all = await page.evaluate(async () => {
    const t = performance.now();
    document.querySelector("#select-visible").click();
    await new Promise(requestAnimationFrame);
    return Math.round(performance.now() - t);
  });
  console.log(`Select all: ${all} ms`);
  if (process.env.SHOT) {
    await page.evaluate(() => (document.querySelector("#file-area").scrollTop = 0));
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${process.env.SHOT}-grid.png` });
    await page.evaluate(() => (document.querySelector("#file-area").scrollTop = 900));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${process.env.SHOT}-scrolled.png` });
    await page.locator("#list-view").click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${process.env.SHOT}-list.png` });
  }
  const heap = await app.evaluate(() => { const m = process.memoryUsage(); return [m.rss, m.heapUsed, m.external, m.arrayBuffers].map((n) => Math.round(n / 1048576)); });
  console.log(`Main process (MB): rss ${heap[0]}, heap ${heap[1]}, external ${heap[2]}, buffers ${heap[3]}`);
  const memory = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => [m.type, Math.round(m.memory.workingSetSize / 1024)]));
  console.log(`Memory (MB): ${memory.map(([type, mb]) => `${type} ${mb}`).join(", ")}`);
} finally {
  await app.close().catch(() => {});
  await rm(home, { recursive: true, force: true });
}
