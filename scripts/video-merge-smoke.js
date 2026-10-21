import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { createVideoTools, videoPlan } from "../packages/core/video-tools.js";
const root = process.cwd(),
  dir = await mkdtemp(path.join(root, "demo/video-merge-"));
const toolDir = path.join(root, "demo/tools/video");
const generated = spawnSync(
  path.join(toolDir, "ffmpeg"),
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=160x90:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-f",
    "dash",
    path.join(dir, "manifest.mpd"),
  ],
  { encoding: "utf8" },
);
assert.equal(generated.status, 0, generated.stderr);
const server = createServer(async (req, res) => {
  try {
    const name = path.basename(new URL(req.url, "http://localhost").pathname);
    const bytes = await readFile(path.join(dir, name));
    res.writeHead(200, {
      "Content-Type": name.endsWith(".mpd")
        ? "application/dash+xml"
        : "application/octet-stream",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const tools = createVideoTools(toolDir);
  const url = `http://127.0.0.1:${server.address().port}/manifest.mpd`;
  const info = await tools.inspect(url),
    job = videoPlan(info, "720");
  const output = path.join(dir, "result.part");
  await tools.transfer({
    job,
    temporaryPath: output,
    signal: new AbortController().signal,
    update: (patch) => Object.assign(job, patch),
  });
  const probe = spawnSync(
    path.join(toolDir, "ffprobe"),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(
    JSON.parse(probe.stdout)
      .streams.map((s) => s.codec_type)
      .sort(),
    ["audio", "video"],
  );
  console.log(
    JSON.stringify({
      mergedAudioAndVideo: true,
      bytes: (await stat(output)).size,
    }),
  );
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
