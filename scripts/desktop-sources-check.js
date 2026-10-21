// Optional live check: catalogs can be unavailable independently of the app.
import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, OBELISK_HOME: path.join(root, "demo") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root], env });
try {
  const page = await app.firstWindow();
  await page.locator(".primary-nav [data-view=discover]").click();
  await page.locator("[data-source=podcasts]").click();
  await page
    .getByRole("textbox", { name: "Search public podcasts" })
    .fill("NPR News Now");
  await page
    .getByRole("button", { name: "Find podcasts", exact: true })
    .click();
  await page.locator(".podcast-card").first().waitFor({ timeout: 35000 });
  await page
    .locator(".podcast-card")
    .filter({
      has: page.getByRole("heading", { name: "NPR News Now", exact: true }),
    })
    .first()
    .getByRole("button")
    .click();
  await page.locator(".episode-row").first().waitFor({ timeout: 35000 });
  await page.screenshot({
    path: path.join(root, "output/desktop/podcasts.png"),
    scale: "css",
  });
  const result = await page.evaluate(async () => {
    const wiki = await window.obelisk.source("wikipedia", {
      language: "eng",
      query: "knots",
    });
    const maps = await window.obelisk.source("maps", {});
    return { wikipedia: wiki.entries.length, maps: maps.builds.length };
  });
  if (!result.wikipedia || !result.maps)
    throw new Error("An expected catalog was empty.");
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
