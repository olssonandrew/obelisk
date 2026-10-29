import { _electron as electron } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = process.cwd();
const note = Buffer.from("Original Obelisk downloader verification, CC0.");
const atom = Buffer.alloc(8);
atom.writeUInt32BE(8 + note.length);
atom.write("free", 4);
const clip = Buffer.concat([
  await readFile("fixtures/motion-study.mp4"),
  atom,
  note,
]);
const server = createServer((req, res) => {
  if (req.url === "/clip.mp4") {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": clip.length,
    });
    res.end(clip);
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<html><head><title>Obelisk downloader demo</title></head><body><video controls src="/clip.mp4"></video></body></html>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const app = await electron.launch({
  ...(process.env.OBELISK_EXECUTABLE
    ? { executablePath: process.env.OBELISK_EXECUTABLE, args: [] }
    : { args: [root] }),
  env: { ...process.env, OBELISK_HOME: root + "/demo" },
  timeout: 120000,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
  await page
    .locator("#collections button")
    .filter({ hasText: "Video" })
    .click();
  await page
    .getByRole("button", { name: "Download a video", exact: true })
    .click();
  const url = `http://127.0.0.1:${server.address().port}/video`;
  await page.locator("#video-form [name=url]").fill(url);
  await page.locator("#video-check").click();
  await page.locator("#video-result h3").waitFor();
  await page.screenshot({ path: "output/desktop/video-download.png" });
  await page.locator("#video-save").click();
  let result;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.obelisk.state());
    const job = s.jobs.find((j) => j.url === url);
    if (job?.status === "failed") throw Error(job.error);
    if (job?.status === "complete") {
      result = s.items.find((i) => i.id === job.itemId);
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(result?.path.startsWith("Video/"), "Video not archived");
  assert.equal(result.bytes, clip.length);
  await page.locator(".primary-nav [data-view=library]").click();
  await page
    .getByRole("button", { name: `Preview ${result.title}`, exact: true })
    .dispatchEvent("dblclick");
  await page.locator("#preview video").evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.waitForFunction(
    () => document.querySelector("#preview video").currentTime > 0.2,
  );
  await page.locator(".primary-nav [data-view=discover]").click();
  const tiles = [];
  page.on("response", (r) => {
    if (
      r.url().startsWith("https://tiles.openfreemap.org/") &&
      r.status() === 200
    )
      tiles.push(r.url());
  });
  await page.locator("[data-source=maps]").click();
  const frame = page.frameLocator("#map-selector");
  await frame
    .locator("body[data-online-state=ready]")
    .waitFor({ state: "attached", timeout: 60000 });
  assert.ok(tiles.length > 0, "No live map tiles received");
  await page.screenshot({ path: "output/desktop/online-map-preview.png" });
  await frame.locator("#online").click();
  await frame.getByRole("button", { name: "Online preview · off" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      saved: result.path,
      playback: true,
      onlineTiles: tiles.length,
      offlineToggle: true,
      errors,
    }),
  );
} finally {
  await app.close();
  server.close();
}
