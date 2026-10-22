import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assetName, compareVersions, changelogSection, releaseNotes, sourceAssetName } from "../scripts/release-lib.js";
import { USER_AGENT } from "../packages/core/agent.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("release downloads are named as in the README", async () => {
  const readme = await read("README.md");
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "x64"]])
    assert.ok(readme.includes(`\`${assetName(platform, arch)}\``), assetName(platform, arch));
  assert.throws(() => assetName("freebsd", "x64"));
});

test("release versions only move forward, and pre-releases come before their release", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("0.2.0-beta.1", "0.2.0") < 0);
  assert.ok(compareVersions("0.2.0-beta.10", "0.2.0-beta.2") > 0);
  assert.throws(() => compareVersions("next", "0.1.0"));
});

test("release notes are the version's changelog section, with where the GPL source is", () => {
  const changelog = "# Changelog\n\n## 0.2.0\n\n- Newer.\n\n## 0.1.0\n\n- First.\n";
  assert.equal(changelogSection(changelog, "0.1.0"), "- First.");
  assert.equal(changelogSection(changelog, "0.1.1"), "");
  const notes = releaseNotes(changelog, "0.2.0");
  assert.ok(notes.startsWith("- Newer."));
  assert.ok(!notes.includes("First."));
  assert.ok(notes.includes(sourceAssetName("0.2.0")));
  assert.throws(() => releaseNotes(changelog, "0.3.0"), /no notes/);
});

test("the documented release command is wired up", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  assert.equal(scripts.release, "node scripts/release.js");
  for (const doc of ["README.md", "AGENTS.md", "CONTRIBUTING.md"]) assert.match(await read(doc), /npm run release -- /, doc);
});

test("this version has release notes, and requests carry its version", async () => {
  const { version } = JSON.parse(await read("package.json"));
  assert.ok(changelogSection(await read("CHANGELOG.md"), version));
  assert.ok(USER_AGENT.startsWith(`Obelisk/${version} (`));
});
