import path from "node:path";
import { mkdir, writeFile, rename, chmod, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";

/** Install tools from their publishers into user data, outside the app bundle. */
export async function installVideoMerger(directory) {
  const get = async (url) => {
    const response = await fetch(url, {
      headers: { "User-Agent": "Obelisk video tool setup" },
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok)
      throw new Error(`Video tool download failed (${response.status}).`);
    return response;
  };
  const installZip = async (url, checksumUrl, names) => {
    const response = await get(url);
    // Use the checksum belonging to the resolved build, not a moving latest URL.
    const sums = await (
      await get(checksumUrl || response.url + ".sha256")
    ).text();
    const basename = new URL(response.url).pathname.split("/").at(-1);
    const expected =
      sums
        .split("\n")
        .find((line) => line.includes(basename))
        ?.match(/[a-f0-9]{64}/)?.[0] ||
      sums.trim().match(/^[a-f0-9]{64}$/)?.[0];
    if (!expected)
      throw new Error("No publisher checksum for the media tools.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Media tool checksum mismatch.");
    const zip = await JSZip.loadAsync(bytes);
    for (const name of names) {
      const matches = Object.values(zip.files).filter(
        (file) => !file.dir && file.name.split("/").at(-1) === name,
      );
      if (matches.length !== 1)
        throw new Error(`Missing ${name} in media tool package.`);
      const partial = path.join(directory, randomUUID() + ".tmp");
      try {
        await writeFile(partial, await matches[0].async("nodebuffer"));
        await chmod(partial, 0o755);
        await rename(partial, path.join(directory, name));
      } finally {
        await rm(partial, { force: true });
      }
    }
    return `${response.url}\nSHA256: ${expected}\n`;
  };
  await mkdir(directory, { recursive: true });
  let source;
  if (
    ["darwin", "linux"].includes(process.platform) &&
    ["x64", "arm64"].includes(process.arch)
  ) {
    const platform = process.platform === "darwin" ? "macos" : "linux",
      arch = process.arch === "x64" ? "amd64" : "arm64";
    const base = `https://ffmpeg.martin-riedl.de/redirect/latest/${platform}/${arch}/release/`;
    source = await installZip(base + "ffmpeg.zip", null, ["ffmpeg"]);
    source += await installZip(base + "ffprobe.zip", null, ["ffprobe"]);
    source +=
      "Build sources: https://git.martin-riedl.de/ffmpeg/build-script\n";
  } else if (process.platform === "win32" && process.arch === "x64") {
    const release = await (
      await get(
        "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest",
      )
    ).json();
    const zip = release.assets.find(
      (asset) => asset.name === "ffmpeg-master-latest-win64-gpl.zip",
    );
    const sums = release.assets.find(
      (asset) => asset.name === "checksums.sha256",
    );
    if (!zip || !sums)
      throw new Error(
        "No supported Windows media tools in the current release.",
      );
    source = await installZip(
      zip.browser_download_url,
      sums.browser_download_url,
      ["ffmpeg.exe", "ffprobe.exe"],
    );
    source += "Build sources: https://github.com/BtbN/FFmpeg-Builds\n";
  } else
    throw new Error(
      "Automatic video setup currently supports macOS/Linux ARM64 and x64, and Windows x64.",
    );
  await writeFile(
    path.join(directory, "FFMPEG-SOURCE.txt"),
    source + "FFmpeg: https://ffmpeg.org/legal.html\n",
  );
  await writeFile(
    path.join(directory, "FFMPEG-LICENSE.txt"),
    await (
      await get(
        "https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv3",
      )
    ).text(),
  );
}
