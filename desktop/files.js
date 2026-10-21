import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
};
export async function inside(root, relative) {
  const base = await realpath(root),
    file = await realpath(path.resolve(base, relative));
  if (!file.startsWith(base + path.sep))
    throw new Error("Path is outside the permitted folder.");
  return file;
}
export async function fileResponse(
  request,
  filename,
  { trusted = false, zimReader = false, cache = false } = {},
) {
  const info = await stat(filename);
  if (!info.isFile()) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "Content-Type":
      mime[path.extname(filename).toLowerCase()] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "obelisk://app",
    // Covers have versioned addresses, so the window may keep them.
    "Cache-Control": cache ? "private, max-age=86400" : "no-store",
  });
  headers.set(
    "Content-Security-Policy",
    zimReader
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' obelisk://zim; img-src obelisk://zim data:; font-src obelisk://zim data:; media-src obelisk://zim; connect-src obelisk://zim; frame-src 'self'; object-src 'none'; base-uri obelisk://zim; form-action 'none'"
      : trusted
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' obelisk://archive obelisk://thumb data: blob: https://tile.openstreetmap.org; media-src obelisk://archive blob:; connect-src 'self' obelisk://archive obelisk://zim blob: https://build.protomaps.com https://tile.openstreetmap.org; worker-src 'self' blob:; frame-src 'self' obelisk://archive; object-src obelisk://archive; base-uri 'none'"
        : "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  );
  let start = 0,
    end = info.size - 1,
    status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start > end || start >= info.size)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  const body =
    request.method === "HEAD" || info.size === 0
      ? null
      : Readable.toWeb(createReadStream(filename, { start, end }));
  return new Response(body, { status, headers });
}
