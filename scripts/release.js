import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, parseVersion, releaseNotes } from "./release-lib.js";
/*
 * npm run release -- 0.2.0 [--push]
 *   Sets the version, commits "Release v0.2.0" and tags it, from a clean main whose
 *   CHANGELOG.md has a "## 0.2.0" section. With --push, pushes main and the tag, which
 *   starts the Release workflow.
 * node scripts/release.js --verify v0.2.0   (the workflow) tag, version and notes agree
 * node scripts/release.js --notes 0.2.0     (the workflow) prints the release notes
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const read = async (file) => readFile(path.join(root, file), "utf8");
const { version: current } = JSON.parse(await read("package.json"));
const [first, second] = process.argv.slice(2).filter((a) => a !== "--push");

if (first === "--notes") process.stdout.write(releaseNotes(await read("CHANGELOG.md"), parseVersion(second).text));
else if (first === "--verify") {
  const tagged = parseVersion(second).text;
  if (tagged !== current) throw new Error(`The tag says ${tagged}; package.json says ${current}.`);
  releaseNotes(await read("CHANGELOG.md"), tagged);
  console.log(`v${tagged} is ready to build.`);
} else {
  if (!first) throw new Error("Name the version: npm run release -- 0.2.0");
  const next = parseVersion(first).text;
  if (git("branch", "--show-current") !== "main") throw new Error("Release from main.");
  if (git("status", "--porcelain")) throw new Error("Commit or stash your changes first.");
  if (git("tag", "--list", `v${next}`)) throw new Error(`v${next} is already tagged.`);
  if (compareVersions(next, current) < 0) throw new Error(`${next} is older than ${current}.`);
  releaseNotes(await read("CHANGELOG.md"), next);
  if (next !== current) execFileSync("npm", ["version", next, "--no-git-tag-version", "--ignore-scripts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  git("commit", "--allow-empty", "-am", `Release v${next}`);
  git("tag", "-a", `v${next}`, "-m", `Obelisk ${next}`);
  if (process.argv.includes("--push")) {
    git("push", "origin", "main", `v${next}`);
    console.log(`Pushed v${next}. The Release workflow builds and publishes it.`);
  } else console.log(`Tagged v${next}. Publish it with: git push origin main v${next}`);
}
