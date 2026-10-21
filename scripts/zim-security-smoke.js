import { _electron as electron } from "playwright-core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { writeZim } from "../tests/helpers/zim-fixture.js";
import { openLibrary } from "../packages/core/library.js";
const root = process.cwd(),
  home = await mkdtemp(path.join(root, "demo/zim-security-"));
let requests = 0,
  app;
const server = createServer((req, res) => {
  requests++;
  res.end("unexpected network access");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const remote = `http://127.0.0.1:${server.address().port}/escape`;
try {
  const filename = path.join(home, "security.zim");
  await writeZim(filename, {
    html: `<html><head><title>Safe archive</title><base href="${remote}"><meta http-equiv="refresh" content="0;url=${remote}"><style>@import url('${remote}');</style></head><body><h1>Safe archive</h1><script>window.pwned=true;fetch('${remote}')</script><img src="${remote}" onerror="window.pwned=true"><iframe src="${remote}"></iframe><form action="${remote}"><button>Submit</button></form><a href="${remote}" target="_top">Outside</a><a href="Alias">Alias</a><a href="Caf%C3%A9">Unicode</a><a href="Missing">Missing page</a><img id="local" src="../I/pixel.svg"></body></html>`,
  });
  const bad = path.join(home, "broken.zim");
  await writeFile(bad, "not an archive");
  const library = await openLibrary(path.join(home, "archive"), home);
  const imported = await library.importPaths([filename, bad]);
  await library.close();
  const env = { ...process.env, OBELISK_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch(env.OBELISK_EXECUTABLE ? { executablePath: env.OBELISK_EXECUTABLE, args: [], env } : { args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page
    .getByRole("button", {
      name: `Preview ${imported[0].item.title}`,
      exact: true,
    })
    .dblclick();
  const reader = page.frameLocator("#preview > iframe"),
    article = reader.frameLocator("#article");
  await article.getByRole("heading", { name: "Safe archive" }).waitFor();
  await article.locator("#local").evaluate((img) => img.decode());
  let proof = await article
    .locator("body")
    .evaluate(() => ({
      pwned: window.pwned === true,
      node: typeof process,
      bridge: typeof window.obelisk,
      scripts: document.querySelectorAll("script,iframe,form,[onerror]").length,
    }));
  assert.deepEqual(proof, {
    pwned: false,
    node: "undefined",
    bridge: "undefined",
    scripts: 0,
  });
  await article.getByRole("link", { name: "Outside", exact: true }).click();
  await reader
    .getByText("That link is outside this saved archive.", { exact: true })
    .waitFor();
  await article
    .getByRole("link", { name: "Missing page", exact: true })
    .click();
  await reader
    .getByText("This page is not included in this archive.", { exact: true })
    .waitFor();
  await article.getByRole("link", { name: "Alias", exact: true }).click();
  await article.getByRole("heading", { name: "Second", exact: true }).waitFor();
  await reader.getByRole("button", { name: "Back", exact: true }).click();
  await article.getByRole("link", { name: "Unicode", exact: true }).click();
  await article.getByRole("heading", { name: "Café", exact: true }).waitFor();
  const src = await page.locator("#preview > iframe").getAttribute("src"),
    token = new URL(src, "obelisk://app/").searchParams.get("token");
  await page.locator("#close-inspector").click();
  assert.equal(
    await page.evaluate(
      async (token) =>
        (await fetch(`obelisk://zim/${token}/content/A/Welcome`)).status,
      token,
    ),
    410,
  );
  await page
    .getByRole("button", {
      name: `Preview ${imported[1].item.title}`,
      exact: true,
    })
    .dblclick();
  await page
    .getByRole("heading", { name: "Couldn’t open this archive" })
    .waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("heading", { name: "Couldn’t open this archive" })
    .waitFor();
  assert.equal(requests, 0);
  console.log(
    "ZIM: scripts removed, remote requests blocked, no desktop bridge; redirects, Unicode, missing pages, teardown and damaged-file retry passed.",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
