// Captures the README screenshots from the demo library (npm run demo:library first).
//   npm run screenshots
import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "docs", "images");
// Its own app folder (made by demo:library), so it runs beside an open copy of Obelisk.
const env = { ...process.env, OBELISK_HOME: path.join(root, "demo", ".builder") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root], env });
const page = await app.firstWindow();
page.setDefaultTimeout(30000);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
await page.waitForFunction(async () => (await window.obelisk.state()).items.length > 20);
const theme = (name) => page.locator(`[data-theme-choice=${name}]`).click();
const folder = (name) => page.locator("#folder-tree .folder-row", { hasText: name }).first().locator(".folder-main").click();
// Thumbnails are made as cards appear; give each view a moment.
const settle = () => page.waitForTimeout(2500);
async function shot(name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  // Retina captures are halved to CSS pixels to keep the README light.
  execFileSync("sips", ["-z", "960", "1440", file], { stdio: "ignore" });
  console.log(`✓ ${name}.png`);
}
try {
  await theme("light");
  await page.locator(".primary-nav [data-view=library]").click();
  await page.locator("#sort").selectOption({ label: "Added, newest" }).catch(() => {});
  await settle();
  await page.locator(".file-card", { hasText: "The Bedroom" }).click();
  await settle();
  await shot("library");

  // A folder with its subfolders as tiles and everything inside them below.
  await folder("Images");
  if (!(await page.locator("#include-subfolders").isChecked())) await page.locator(".switch").click();
  await settle();
  await shot("folder");
  await page.locator("#include-subfolders").setChecked(false, { force: true });

  await page.locator(".primary-nav [data-view=discover]").click();
  await settle();
  await shot("import");

  // A collection's own page, from the row on Add content's front page.
  await page.locator("#collections-home .collection-card", { hasText: "Art Institute" }).click();
  await settle();
  await shot("collection");
  await page.locator(".collection-back").click();

  await folder("Maps");
  await page.locator(".file-card", { hasText: "Kyoto" }).dblclick();
  await page.waitForTimeout(6000);
  await shot("maps");
  await page.keyboard.press("Escape");

  await theme("dark");
  await folder("Images");
  await page.locator(".folder-tile", { hasText: "Space" }).click();
  await settle();
  await page.locator(".file-card", { hasText: "Carina" }).click();
  await settle();
  await shot("dark");
  await theme("system");
} finally {
  await app.close();
}
