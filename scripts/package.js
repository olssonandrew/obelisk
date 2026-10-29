import { packager } from "@electron/packager";
import { sign } from "@electron/osx-sign";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCommitted, assetName } from "./release-lib.js";
// Builds Obelisk for this computer into dist/. With --zip, also the download named as
// in the README (dist/Obelisk-mac-arm64.zip), from committed code with the map tool.
const root = fileURLToPath(new URL("../", import.meta.url));
const zip = process.argv.includes("--zip");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
// The download is published beside the source of its commit, so it's built from one.
if (zip) assertCommitted(root);

const tool = JSON.parse(await readFile(path.join(root, ".tools/release.json"), "utf8").catch(() => "null"));
const wanted = `${{ darwin: "Darwin", win32: "Windows", linux: "Linux" }[process.platform]}_${{ arm64: "arm64", x64: "x86_64" }[process.arch]}`;
if (!tool?.asset.includes(wanted)) {
  const message = `The map tool for ${wanted} isn't in .tools/. Run npm run setup:maps first.`;
  if (zip) throw new Error(message);
  console.warn(`${message} Map downloads won't work in this build.`);
}

// Only what the app runs. node_modules is pruned to runtime dependencies; scripts/seed.js
// and fixtures/ make the demo library.
const keep = [
  "/package.json",
  "/LICENSE",
  "/desktop",
  "/packages",
  "/node_modules",
  "/.tools",
  "/fixtures",
  "/scripts/seed.js",
  "/collections/collections.json",
  "/docs/third-party.md",
];
const ignore = (file) =>
  Boolean(file) &&
  (/(^|\/)\.DS_Store$/.test(file) || !keep.some((k) => file === k || file.startsWith(`${k}/`) || k.startsWith(`${file}/`)));

const [out] = await packager({
  dir: root,
  name: "Obelisk",
  out: path.join(root, "dist"),
  icon: path.join(root, "desktop/assets/icon"),
  overwrite: true,
  asar: false,
  prune: true,
  ignore,
  appBundleId: "org.obelisk.archive",
  appCategoryType: "public.app-category.productivity",
});

if (process.platform === "darwin") {
  const app = path.join(out, "Obelisk.app");
  // The download is the app alone, so Electron's and Chromium's licenses go inside it.
  for (const name of ["LICENSE", "LICENSES.chromium.html"])
    await copyFile(path.join(out, name), path.join(app, "Contents/Resources", name === "LICENSE" ? "LICENSE.electron" : name));
  // Signed with a Developer ID and notarized when the signing settings are there (the
  // release workflow sets them; see CONTRIBUTING.md). Otherwise a build still needs
  // a whole signature: renaming Electron breaks the one it ships with, and macOS calls
  // a downloaded app with a broken signature "damaged".
  const { APPLE_TEAM_ID: team, APPLE_API_KEY_PATH: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  const signing = Boolean(team && key && keyId && issuer);
  if (!signing && process.env.OBELISK_REQUIRE_SIGNING) throw new Error("This build must be signed, but the Apple signing settings are missing.");
  if (signing) {
    await sign({
      app,
      platform: "darwin",
      identity: `Developer ID Application`,
      keychain: process.env.MAC_SIGN_KEYCHAIN || undefined,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(root, "desktop/entitlements.mac.plist") }),
    });
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const signer = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
    if (!signer.includes(`TeamIdentifier=${team}`)) throw new Error(`Signed by the wrong team:\n${signer}`);
    // Apple scans it, then the approval is stapled on so it opens without a connection.
    const upload = path.join(path.dirname(app), "Obelisk-notarize.zip");
    run("ditto", ["-c", "-k", "--keepParent", app, upload]);
    const notary = ["--key", key, "--key-id", keyId, "--issuer", issuer, "--output-format", "json"];
    const result = JSON.parse(execFileSync("xcrun", ["notarytool", "submit", upload, ...notary, "--wait"], { encoding: "utf8" }));
    await rm(upload, { force: true });
    if (result.status !== "Accepted") {
      const log = execFileSync("xcrun", ["notarytool", "log", result.id, ...notary.slice(0, -2)], { encoding: "utf8" });
      throw new Error(`Apple didn't accept the app (${result.status}):\n${log}`);
    }
    run("xcrun", ["stapler", "staple", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  } else {
    run("codesign", ["--force", "--deep", "--sign", "-", app]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
  }
}

if (zip) {
  const file = path.join(root, "dist", assetName(process.platform, process.arch));
  await rm(file, { force: true });
  if (process.platform === "darwin") run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(out, "Obelisk.app"), file]);
  // Windows' own tar writes ZIP; Git's tar, often first on the PATH, doesn't.
  else if (process.platform === "win32")
    run(path.join(process.env.SystemRoot, "System32", "tar.exe"), ["-a", "-c", "-f", file, path.basename(out)], path.dirname(out));
  else run("zip", ["-q", "-r", "-y", file, path.basename(out)], path.dirname(out));
  console.log(file);
}
console.log(out);
