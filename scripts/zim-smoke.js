import { _electron as electron } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  env = { ...process.env, OBELISK_HOME: path.join(root, "demo") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch(
  env.OBELISK_EXECUTABLE
    ? { executablePath: env.OBELISK_EXECUTABLE, args: [], env }
    : { args: [root], env },
);
app.process().stderr.on("data", (d) => process.stderr.write(d));
let passed = false;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("BROWSER:", m.text());
  });
  await page.waitForFunction(() => !!window.obelisk);
  const state = await page.evaluate(() => window.obelisk.state());
  assert.equal(state.archiveRoot, path.join(root, "demo/archive"));
  const zim = state.items.find((i) => i.filename.endsWith(".zim"));
  assert.ok(zim);
  // Disable networking at Electron session level before opening any archive content.
  await app.evaluate(({ session }) =>
    session.defaultSession.enableNetworkEmulation({ offline: true }),
  );
  await page.locator("#search").fill(zim.title);
  await page
    .getByRole("button", { name: `Preview ${zim.title}`, exact: true })
    .dblclick();
  const reader = page.frameLocator("#preview > iframe");
  await reader.locator("#message").waitFor({ state: "hidden" });
  const article = reader.frameLocator("#article");
  await article.locator("a.item").first().waitFor();
  console.log("Welcome", await article.locator("a.item").first().innerText());
  await reader.getByRole("searchbox").fill("Bowline");
  await reader.locator("#matches button").first().waitFor();
  console.log("Search", await reader.locator("#matches").innerText());
  await reader.getByRole("button", { name: "Bowline", exact: true }).click();
  await article.locator("h1").filter({ hasText: "Bowline" }).waitFor();
  await page.waitForTimeout(500);
  await article
    .locator("img")
    .first()
    .evaluate((image) => image.decode());
  assert.ok(
    await article
      .locator("img")
      .first()
      .evaluate((image) => image.naturalWidth > 0),
  );
  const reading = await article.locator("body").evaluate(() => ({
    bridge: typeof window.obelisk,
    node: typeof process,
    title: document.title,
  }));
  assert.equal(reading.bridge, "undefined");
  assert.equal(reading.node, "undefined");
  await reader.getByRole("button", { name: "Back", exact: true }).click();
  await article.locator("a.item").first().waitFor();
  await reader.getByRole("button", { name: "Forward", exact: true }).click();
  await article.locator("h1").filter({ hasText: "Bowline" }).waitFor();
  await reader.locator("#mode").selectOption("fulltext");
  await reader.getByRole("searchbox").fill("rope");
  await reader.getByRole("searchbox").press("Enter");
  await reader.locator("#matches button").first().waitFor();
  console.log("Fulltext", await reader.locator("#result-count").innerText());
  await reader.locator("#close-results").click();
  await reader
    .getByRole("button", { name: "Larger text", exact: true })
    .click();
  assert.equal(
    await article.locator("html").evaluate((e) => Number(e.style.zoom)),
    1.1,
  );
  await reader
    .getByRole("button", { name: "Smaller text", exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  const bounds = await reader
    .locator("body")
    .evaluate((e) => ({ width: e.scrollWidth, limit: innerWidth }));
  assert.ok(bounds.width <= bounds.limit + 1, JSON.stringify(bounds));
  await page.locator("#expand-preview").click();
  assert.ok(await page.locator("#preview > iframe").isVisible());
  await page.locator("#expand-preview").click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1460, 960),
  );
  await reader.locator("#mode").selectOption("titles");
  await reader.getByRole("searchbox").fill("");
  await reader.locator("#results").waitFor({ state: "hidden" });
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({ path: "output/playwright/zim-reader.png" });
  await reader.getByRole("searchbox").fill("Lucet");
  await reader.getByRole("button", { name: "Lucet", exact: true }).click();
  await article.getByRole("heading", { name: "Lucet", exact: true }).waitFor();
  for (const [theme, expected] of [
    ["light", "rgb(248, 249, 250)"],
    ["dark", "rgb(16, 20, 24)"],
  ]) {
    await page.evaluate((theme) => {
      localStorage.setItem("theme", theme);
      window.applyTheme();
    }, theme);
    await article.locator("html").evaluate(async (element, theme) => {
      for (let i = 0; i < 30 && element.dataset.obeliskTheme !== theme; i++)
        await new Promise((r) => setTimeout(r, 50));
      window.scrollTo(0, innerHeight * 1.7);
    }, theme);
    const canvas = await article.locator("html").evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(document.querySelector(".mw-page-container"))
        .backgroundColor,
      heading: getComputedStyle(document.querySelector("h2")).color,
      top: scrollY,
      viewport: innerHeight,
      height: element.getBoundingClientRect().height,
    }));
    assert.equal(canvas.background, expected);
    assert.equal(canvas.body, expected);
    assert.equal(
      canvas.panel,
      theme === "dark" ? "rgb(16, 20, 24)" : "rgb(255, 255, 255)",
    );
    assert.equal(
      canvas.heading,
      theme === "dark" ? "rgb(248, 249, 250)" : "rgb(16, 20, 24)",
    );
    assert.ok(canvas.top > canvas.viewport);
    assert.ok(canvas.height > canvas.viewport * 2);
    if (theme === "dark")
      await page.screenshot({ path: "output/playwright/zim-dark-scroll.png" });
  }
  console.log(
    "Dark and light article backgrounds remain correct beyond the viewport.",
  );
  assert.deepEqual(errors, []);
  console.log("ZIM reader passed offline smoke");
  await app.evaluate(({ session }) =>
    session.defaultSession.disableNetworkEmulation(),
  );
  passed = true;
} finally {
  if (passed && process.env.OBELISK_LEAVE_OPEN === "1") {
    console.log("Obelisk is open for review.");
    await new Promise((resolve) => app.on("close", resolve));
  } else await app.close();
}
