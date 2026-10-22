import path from "node:path";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  access,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { installVideoMerger } from "./video-merger.js";
import { safeFilename } from "./archive.js";
import { USER_AGENT } from "./agent.js";

export function videoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Paste a valid video URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  return url.href;
}
export function videoPlan(info, quality = "1080") {
  if (!["720", "1080", "2160"].includes(String(quality)))
    throw new Error("Choose a supported quality.");
  if (!info || info.is_live || info.has_drm || info._type === "playlist")
    throw new Error("Choose a single, non-live video without DRM.");
  const url = videoUrl(info.webpage_url || info.original_url);
  return {
    driver: "video",
    url,
    quality: String(quality),
    filename: safeFilename(`${info.title || "Video"}.mp4`),
    title: String(info.title || "Video").slice(0, 200),
    creator: String(info.uploader || info.channel || "").slice(0, 200),
    type: "video",
    description: String(info.description || "").slice(0, 4000),
    rights: String(
      info.license ||
        "Rights remain with the creator. Download only where authorized.",
    ),
    source: {
      adapter: "video",
      provider: String(info.extractor_key || info.extractor || "Video URL"),
      url,
      videoId: String(info.id || ""),
      creator: String(info.uploader || info.channel || ""),
      uploaded: String(info.upload_date || info.release_date || ""),
      duration: info.duration || null,
      seriesKey: `video:${url}:quality:${quality}`,
      version: "1",
    },
  };
}
function run(executable, args, { signal, onLine, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Paused"));
    const child = spawn(executable, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let output = "",
      tail = "",
      buffer = "",
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(output);
    };
    let killTimer;
    const stop = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const abort = () => {
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 3000);
    };
    const timer = setTimeout(() => {
      abort();
      tail = "The video service took too long. Try again.";
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) {
        tail = "Video metadata was too large.";
        abort();
      }
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        onLine?.(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      tail = (tail + chunk).slice(-3000);
    });
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        signal?.aborted
          ? new Error("Paused")
          : code === 0
            ? null
            : new Error(tail.trim() || `Video download exited (${code}).`),
      ),
    );
  });
}
export function createVideoTools(directory) {
  const ffmpeg = path.join(
    directory,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const ffprobe = path.join(
    directory,
    process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
  );
  const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const executable = path.join(directory, filename);
  let installing;
  const common = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-cache-dir",
    "--no-playlist",
    "--no-update",
    "--no-warnings",
    "--no-js-runtimes",
    "--js-runtimes",
    `node:${process.execPath}`,
  ];
  const status = async () => ({
    ready: await Promise.all(
      [executable, ffmpeg, ffprobe].map((file) => access(file)),
    )
      .then(() => true)
      .catch(() => false),
    installing: !!installing,
  });
  async function install() {
    if (installing) return installing;
    installing = (async () => {
      if (
        await access(executable)
          .then(() => true)
          .catch(() => false)
      ) {
        await installVideoMerger(directory);
        return { ready: true, installing: false };
      }
      const asset =
        process.platform === "darwin"
          ? "yt-dlp_macos"
          : process.platform === "win32"
            ? process.arch === "arm64"
              ? "yt-dlp_arm64.exe"
              : "yt-dlp.exe"
            : process.platform === "linux"
              ? process.arch === "arm64"
                ? "yt-dlp_linux_aarch64"
                : process.arch === "x64"
                  ? "yt-dlp_linux"
                  : null
              : null;
      if (!asset)
        throw new Error("Video tool setup is unavailable for this platform.");
      const get = async (url) => {
        const r = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok) throw new Error(`Video tool download failed (${r.status}).`);
        return r;
      };
      const release = await (
        await get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
      ).json();
      if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(release.tag_name))
        throw new Error("Unexpected video tool release.");
      const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/`;
      const sums = await (await get(base + "SHA2-256SUMS")).text();
      const line = sums
        .split("\n")
        .find((l) => l.trim().split(/\s+/).at(-1) === asset);
      const expected = line?.split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/.test(expected || ""))
        throw new Error("No publisher checksum for the video tool.");
      const bytes = Buffer.from(await (await get(base + asset)).arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        throw new Error("Video tool checksum mismatch.");
      await mkdir(directory, { recursive: true });
      const notices = await (
        await get(
          `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/THIRD_PARTY_LICENSES.txt`,
        )
      ).text();
      await writeFile(
        path.join(directory, "THIRD_PARTY_LICENSES.txt"),
        notices,
      );
      await writeFile(
        path.join(directory, "SOURCE.txt"),
        `yt-dlp ${release.tag_name}\nBinary: ${base + asset}\nSHA256: ${expected}\nSource: https://github.com/yt-dlp/yt-dlp/tree/${release.tag_name}\nStandalone binaries contain GPLv3+ components. See third-party licenses.\n`,
      );
      const partial = path.join(directory, randomUUID() + ".tmp");
      try {
        await writeFile(partial, bytes);
        await chmod(partial, 0o755);
        await rename(partial, executable);
      } finally {
        await rm(partial, { force: true });
      }
      await installVideoMerger(directory);
      return { ready: true, installing: false };
    })();
    try {
      return await installing;
    } finally {
      installing = null;
    }
  }
  async function inspect(url) {
    if (!(await status()).ready)
      throw new Error("Set up the video downloader first.");
    const info = JSON.parse(
      await run(executable, [
        ...common,
        "--skip-download",
        "--dump-single-json",
        "--",
        videoUrl(url),
      ]),
    );
    videoPlan(info);
    return {
      title: info.title,
      id: info.id,
      webpage_url: info.webpage_url || url,
      extractor: info.extractor,
      extractor_key: info.extractor_key,
      uploader: info.uploader,
      channel: info.channel,
      upload_date: info.upload_date,
      release_date: info.release_date,
      duration: info.duration,
      description: info.description,
      license: info.license,
      is_live: info.is_live,
      has_drm: info.has_drm,
      _type: info._type,
    };
  }
  async function transfer({ job, temporaryPath, signal, update }) {
    if (!(await status()).ready)
      throw new Error("Set up the video downloader, then resume.");
    const work = temporaryPath + ".video";
    await mkdir(work, { recursive: true });
    const height = Number(job.quality);
    if (![720, 1080, 2160].includes(height))
      throw new Error("Invalid video quality.");
    update({ phase: "Downloading video", resumable: true });
    const format = `bv*[vcodec^=avc1][height<=?${height}]+ba[ext=m4a]/b[ext=mp4][height<=?${height}]/bv*[height<=?${height}]+ba/b[height<=?${height}]`;
    await run(
      executable,
      [
        ...common,
        "--ffmpeg-location",
        ffmpeg,
        "--format",
        format,
        "--merge-output-format",
        "mp4",
        "--newline",
        "--progress",
        "--progress-template",
        "download:PROGRESS:%(progress.downloaded_bytes)s:%(progress.total_bytes_estimate)s",
        "--output",
        path.join(work, "media.%(ext)s"),
        "--",
        videoUrl(job.url),
      ],
      {
        signal,
        timeout: 24 * 60 * 60 * 1000,
        onLine: (line) => {
          const m = /^PROGRESS:(\d+):([\d.]+|NA)/.exec(line);
          if (m)
            update({
              bytes: Number(m[1]),
              total: m[2] === "NA" ? null : Number(m[2]),
            });
        },
      },
    );
    const files = (await readdir(work)).filter((f) =>
      /^media\.(mp4|webm|mkv|mov)$/.test(f),
    );
    if (files.length !== 1)
      throw new Error(
        "The downloader did not produce one supported video file.",
      );
    const final = path.join(work, files[0]),
      bytes = (await stat(final)).size;
    await rename(final, temporaryPath);
    await rm(work, { recursive: true, force: true });
    update({
      bytes,
      total: bytes,
      filename: safeFilename(`${job.title}.${files[0].split(".").at(-1)}`),
      phase: "Saving to archive",
    });
  }
  return { status, install, inspect, transfer };
}
