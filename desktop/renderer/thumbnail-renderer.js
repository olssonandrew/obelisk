import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = new URL(
  "./pdf.worker.mjs",
  import.meta.url,
).href;
function raster(source) {
  const canvas = document.createElement("canvas");
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) throw new Error("No image");
  canvas.width = Math.min(480, width);
  canvas.height = Math.min(960, Math.round((height * canvas.width) / width));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
// How much a frame has going on: spread of brightness plus colour. Black frames,
// fades and plain title cards score low.
function liveliness(source) {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 27;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 48, 27);
  const { data } = ctx.getImageData(0, 0, 48, 27);
  let sum = 0, squares = 0, colour = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]],
      luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma;
    squares += luma * luma;
    colour += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, squares / n - mean * mean));
  // Very dark or washed-out frames rarely make a good cover.
  const exposure = mean < 30 || mean > 235 ? 0.3 : 1;
  return (spread + colour / n) * exposure;
}
async function videoFrame(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  const seek = (time) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview timeout")), 8000);
      video.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
      video.currentTime = time;
    });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Preview timeout")), 12000);
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Unsupported video"));
      };
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.src = url;
    });
    // A few moments through the video; the liveliest becomes the cover.
    const length = Number.isFinite(video.duration) ? video.duration : 0;
    const times = length ? [0.2, 0.35, 0.5, 0.65].map((f) => f * length) : [0];
    let best = null, score = -1;
    for (const time of times) {
      try {
        await seek(time);
      } catch {
        continue;
      }
      const value = liveliness(video);
      if (value > score) {
        score = value;
        best = raster(video);
      }
    }
    if (!best) throw new Error("No frame");
    return best;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
// A note's cover is its first lines on a page.
async function textCover(url, ext) {
  const response = await fetch(url, { headers: { Range: "bytes=0-4095" } });
  let text = new TextDecoder().decode(await response.arrayBuffer()).replace(/\uFFFD+$/, "");
  const lines = text.split(/\r?\n/);
  let title = "";
  if (ext !== "txt" && /^#\s+/.test(lines[0] || "")) title = lines.shift().replace(/^#\s+/, "");
  const body = lines
    .map((line) => (ext === "txt" ? line : line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "• ").replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")))
    .filter((line, i, all) => line.trim() || (i && all[i - 1].trim()));
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, 480, 360);
  const margin = 40, width = 480 - margin * 2;
  let y = 58;
  const wrap = (line, font, height, colour, maxLines = 3) => {
    ctx.font = font;
    ctx.fillStyle = colour;
    const words = line.split(/\s+/);
    let current = "", count = 0;
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width > width && current) {
        ctx.fillText(current, margin, y);
        y += height;
        current = word;
        if (++count >= maxLines) return;
      } else current = next;
    }
    if (current) {
      ctx.fillText(current, margin, y);
      y += height;
    }
  };
  if (title) {
    wrap(title, "600 30px Georgia, serif", 36, "#1d1a24", 2);
    y += 10;
  }
  for (const line of body) {
    if (y > 340) break;
    if (!line.trim()) {
      y += 10;
      continue;
    }
    wrap(line, "17px -apple-system, system-ui, sans-serif", 26, "#4a4556", 2);
  }
  return canvas.toDataURL("image/jpeg", 0.88);
}
const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
function localPath(base, href) {
  const url = new URL(href, "https://epub.invalid/" + base);
  if (url.origin !== "https://epub.invalid")
    throw new Error("External EPUB cover");
  return decodeURIComponent(url.pathname.slice(1));
}
async function epubCover(url, bytes) {
  if (bytes > 64 * 1024 ** 2) return null;
  const zip = await JSZip.loadAsync(await (await fetch(url)).arrayBuffer());
  async function entry(name, format, max) {
    const file = zip.file(name);
    if (!file || file._data?.uncompressedSize > max)
      throw new Error("No small cover available");
    return file.async(format);
  }
  const container = xml(
    await entry("META-INF/container.xml", "string", 100000),
  );
  const opfPath = container
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!opfPath) return null;
  const opf = xml(await entry(opfPath, "string", 2_000_000));
  const id = opf.querySelector('meta[name="cover"]')?.getAttribute("content");
  const entries = [...opf.querySelectorAll("manifest > item")];
  const cover =
    entries.find((e) =>
      (e.getAttribute("properties") || "").split(/\s+/).includes("cover-image"),
    ) ||
    entries.find((e) => id && e.id === id) ||
    entries.find(
      (e) =>
        /cover/i.test(e.getAttribute("href") || "") &&
        /^image\/(jpeg|png|webp)$/.test(e.getAttribute("media-type") || ""),
    );
  if (
    !cover ||
    !/^image\/(jpeg|png|webp)$/.test(cover.getAttribute("media-type") || "")
  )
    return null;
  const data = await entry(
    localPath(opfPath, cover.getAttribute("href")),
    "uint8array",
    12_000_000,
  );
  const blob = URL.createObjectURL(
    new Blob([data], { type: cover.getAttribute("media-type") }),
  );
  try {
    const image = new Image();
    image.src = blob;
    await image.decode();
    return raster(image);
  } finally {
    URL.revokeObjectURL(blob);
  }
}
async function pdfCover(url) {
  const base = new URL("./", import.meta.url).href;
  const task = getDocument({
    url,
    isEvalSupported: false,
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: base + "standard_fonts/",
    wasmUrl: base + "wasm/",
  });
  const timer = setTimeout(() => {
    void task.destroy();
  }, 15000);
  try {
    const doc = await task.promise,
      page = await doc.getPage(1);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(480 / original.width, 720 / original.height),
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport })
      .promise;
    return raster(canvas);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
async function audioCover(url) {
  const head = new Uint8Array(
    await (await fetch(url, { headers: { Range: "bytes=0-9" } })).arrayBuffer(),
  );
  if (
    String.fromCharCode(...head.slice(0, 3)) !== "ID3" ||
    ![3, 4].includes(head[3]) ||
    head[5]
  )
    return null;
  const sync = (bytes) => bytes.reduce((n, b) => n * 128 + (b & 127), 0);
  const length = sync(head.slice(6, 10));
  if (!length || length > 8_000_000) return null;
  const bytes = new Uint8Array(
    await (
      await fetch(url, { headers: { Range: `bytes=10-${length + 9}` } })
    ).arrayBuffer(),
  );
  for (let offset = 0; offset + 10 <= bytes.length;) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size =
      head[3] === 4
        ? sync(bytes.slice(offset + 4, offset + 8))
        : new DataView(bytes.buffer).getUint32(offset + 4);
    if (!size || offset + 10 + size > bytes.length) break;
    if (id === "APIC" && !bytes[offset + 8] && !bytes[offset + 9]) {
      const frame = bytes.slice(offset + 10, offset + 10 + size),
        encoding = frame[0];
      let cursor = 1;
      while (cursor < frame.length && frame[cursor]) cursor++;
      const mime = new TextDecoder().decode(frame.slice(1, cursor));
      cursor += 2;
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
        return null;
      if ([1, 2].includes(encoding)) {
        while (
          cursor + 1 < frame.length &&
          (frame[cursor] || frame[cursor + 1])
        )
          cursor += 2;
        cursor += 2;
      } else {
        while (cursor < frame.length && frame[cursor]) cursor++;
        cursor++;
      }
      const blob = URL.createObjectURL(
        new Blob([frame.slice(cursor)], { type: mime }),
      );
      try {
        const image = new Image();
        image.src = blob;
        await image.decode();
        return raster(image);
      } finally {
        URL.revokeObjectURL(blob);
      }
    }
    offset += 10 + size;
  }
  return null;
}
export async function renderThumbnail(item, url) {
  const ext = item.filename.split(".").pop().toLowerCase();
  if (item.media === "audio") {
    if (ext === "mp3") {
      try {
        const art = await audioCover(url);
        if (art) return art;
      } catch {}
    }
    // No picture inside the file: the library draws its sound instead.
    return null;
  }
  if (item.media === "video") return videoFrame(url);
  if (ext === "epub") return epubCover(url, item.bytes);
  if (ext === "pdf") return pdfCover(url);
  if (["md", "markdown", "txt"].includes(ext)) return textCover(url, ext);
  return null;
}
