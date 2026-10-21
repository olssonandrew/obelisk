import { nativeImage, dialog } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, realpath, access, stat } from "node:fs/promises";
import path from "node:path";
import { mediaOf } from "../packages/types/index.js";

const validPeaks = (value) =>
  Array.isArray(value?.peaks) && value.peaks.length >= 20 && value.peaks.length <= 200 &&
  value.peaks.every((p) => typeof p === "number" && p >= 0 && p <= 1) &&
  typeof value.seconds === "number" && value.seconds > 0 && Number.isFinite(value.seconds);

export function thumbnailStore(getLibrary, getWindow) {
  async function destination(id, kind = "image") {
    const library = getLibrary(), item = library.catalog.get(id);
    if (!item || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("No thumbnail available.");
    const root = await realpath(library.archiveRoot);
    const metadata = path.join(root, ".obelisk");
    await mkdir(metadata, {recursive: true});
    if (!(await realpath(metadata)).startsWith(root + path.sep)) throw new Error("Metadata folder is outside this archive.");
    const directory = path.join(metadata, "thumbnails");
    await mkdir(directory, {recursive: true});
    if (!(await realpath(directory)).startsWith(root + path.sep)) throw new Error("Thumbnail folder is outside this archive.");
    // Audio covers have their own key so drawings from older versions are not reused.
    const salt = mediaOf(item.filename) === "audio" ? ":cover" : "";
    const key = createHash("sha256").update(item.id + item.sha256 + salt).digest("hex");
    return path.join(directory, key + (kind === "peaks" ? ".json" : ".jpg"));
  }
  const peaks = {
    async get(id) {
      try {
        const saved = JSON.parse(await readFile(await destination(id, "peaks"), "utf8"));
        return validPeaks(saved) ? saved : null;
      } catch { return null; }
    },
    /** About half a kilobyte per recording; drawn fresh each time, never as an image. */
    async save(id, value) {
      if (!validPeaks(value)) throw new Error("Could not read this recording.");
      const result = { peaks: value.peaks, seconds: value.seconds };
      const filename = await destination(id, "peaks"), temporary = filename + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(result));
        await rename(temporary, filename);
      } finally { await rm(temporary, {force: true}); }
      return result;
    },
  };
  async function save(id, data, replace = false) {
    if (typeof data !== "string" || data.length > 3_000_000 || !/^data:image\/(jpeg|png|webp);base64,/.test(data)) throw new Error("Choose a small image.");
    const image = nativeImage.createFromDataURL(data);
    if (image.isEmpty()) throw new Error("Could not read this image.");
    const filename = await destination(id), temporary = filename + "." + randomUUID() + ".tmp";
    if (!replace) { try { return "data:image/jpeg;base64," + (await readFile(filename)).toString("base64"); } catch {} }
    const dimensions = image.getSize();
    const resized = dimensions.height > dimensions.width * 2 ? image.resize({height:960}) : image.resize({width:480});
    try {
      await writeFile(temporary, resized.toJPEG(85));
      await rename(temporary, filename);
    } finally { await rm(temporary, {force: true}); }
    return "data:image/jpeg;base64," + resized.toJPEG(85).toString("base64");
  }
  // Photos are shrunk once, in the background, a few at a time; the grid never decodes originals.
  const making = new Map(), waiting = [];
  let busy = 0;
  const turn = () => new Promise((resolve) => (busy < 3 ? (busy++, resolve()) : waiting.push(resolve)));
  const done = () => (waiting.length ? waiting.shift()() : busy--);
  async function shrink(id, filename) {
    const { item, filename: original } = await getLibrary().resolveItem(id);
    if (mediaOf(item.filename) !== "image") return null;
    await turn();
    try {
      let image = null;
      try {
        // The system's own previews (Quick Look, Windows Shell) are fast and read most formats.
        image = await nativeImage.createThumbnailFromPath(original, { width: 720, height: 720 });
      } catch {}
      if (!image || image.isEmpty()) {
        const full = nativeImage.createFromPath(original);
        if (full.isEmpty()) return null;
        const { width, height } = full.getSize();
        image = width >= height ? full.resize({ width: Math.min(width, 720) }) : full.resize({ height: Math.min(height, 720) });
      }
      const temporary = filename + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, image.toJPEG(82));
        await rename(temporary, filename);
      } finally { await rm(temporary, {force: true}); }
      return filename;
    } finally { done(); }
  }
  /** The saved cover for a file, made now for photos that have none yet. */
  async function file(id) {
    const filename = await destination(id);
    try { await access(filename); return filename; } catch {}
    if (!making.has(filename))
      making.set(filename, shrink(id, filename).catch(() => null).finally(() => making.delete(filename)));
    return making.get(filename);
  }
  return {
    peaks,
    file,
    /** An address for the saved cover, not its bytes; the window loads it like any image. */
    async get(id) {
      try {
        const { mtimeMs } = await stat(await destination(id));
        return `obelisk://thumb/${encodeURIComponent(id)}?v=${Math.round(mtimeMs)}`;
      } catch { return null; }
    },
    save,
    async choose(id) {
      const result = await dialog.showOpenDialog(getWindow(), {title: "Choose cover image", properties: ["openFile"], filters: [{name: "Images", extensions: ["jpg", "jpeg", "png", "webp"]}]});
      if (result.canceled) return null;
      const image = nativeImage.createFromPath(result.filePaths[0]);
      if (image.isEmpty()) throw new Error("Could not read this image.");
      return save(id, image.resize({width: 480}).toDataURL(), true);
    }
  };
}
