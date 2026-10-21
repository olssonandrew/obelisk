// macOS shows some folders as single files ("packages"): Apple Books keeps EPUBs this
// way, and Pages, Keynote and others use them too. They are kept as one file: EPUBs
// become a standard .epub, anything else a .zip of the folder.
import { open, readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const PACKAGES = new Set(["epub", "rtfd", "pages", "numbers", "key", "band", "logicx", "fcpbundle", "photoslibrary", "musiclibrary", "imovielibrary", "sketch", "pkg", "mpkg", "bundle", "framework", "plugin", "xcodeproj", "playground", "scriptd", "workflow"]);
const MAX = 4 * 1024 ** 3 - 1;

/** The kind of single file a package folder becomes, or null for an ordinary folder. */
export function packageOf(folder) {
  const ext = path.extname(folder).slice(1).toLowerCase();
  if (!PACKAGES.has(ext)) return null;
  return ext === "epub" ? { name: path.basename(folder), format: "epub" } : { name: `${path.basename(folder)}.zip`, format: "zip" };
}

async function listFiles(folder, relative = "", found = []) {
  for (const child of await readdir(path.join(folder, relative), { withFileTypes: true })) {
    if (child.name === ".DS_Store") continue;
    const name = relative ? `${relative}/${child.name}` : child.name;
    if (child.isDirectory()) await listFiles(folder, name, found);
    else if (child.isFile()) found.push(name);
  }
  return found;
}

/** Total size of the files inside a package folder. */
export async function packageSize(folder) {
  let bytes = 0;
  for (const name of await listFiles(folder)) bytes += (await lstat(path.join(folder, name))).size;
  return bytes;
}

/**
 * Writes the folder as a ZIP. For an EPUB, `mimetype` goes first and uncompressed, as
 * the format requires; everything else is compressed.
 */
export async function zipPackage(folder, target, format) {
  const names = await listFiles(folder);
  if (format === "epub") {
    names.sort((a, b) => (a === "mimetype" ? -1 : b === "mimetype" ? 1 : 0));
    if (names[0] !== "mimetype") throw new Error("This EPUB folder has no mimetype file.");
  }
  const out = await open(target, "w"),
    entries = [];
  let position = 0;
  const write = async (data) => {
    await out.write(data);
    position += data.length;
  };
  const now = new Date(),
    time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const header = (central, e) => {
    const name = Buffer.from(e.name),
      head = Buffer.alloc(central ? 46 : 30);
    let at = head.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, 0);
    if (central) at = head.writeUInt16LE(20, at);
    at = head.writeUInt16LE(20, at);
    at = head.writeUInt16LE(0x0800, at);
    at = head.writeUInt16LE(e.method, at);
    at = head.writeUInt16LE(time, at);
    at = head.writeUInt16LE(date, at);
    at = head.writeUInt32LE(e.crc, at);
    at = head.writeUInt32LE(e.packed, at);
    at = head.writeUInt32LE(e.size, at);
    head.writeUInt16LE(name.length, at);
    if (central) head.writeUInt32LE(e.offset, 42);
    return Buffer.concat([head, name]);
  };
  try {
    for (const name of names) {
      const data = await readFile(path.join(folder, name)),
        stored = name === "mimetype" && format === "epub",
        body = stored ? data : zlib.deflateRawSync(data);
      const entry = { name, method: stored ? 0 : 8, crc: zlib.crc32(data), size: data.length, packed: body.length, offset: position };
      if (position + body.length > MAX) throw new Error("This package is too large to keep as one file.");
      await write(header(false, entry));
      await write(body);
      entries.push(entry);
    }
    const start = position;
    for (const entry of entries) await write(header(true, entry));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
  } finally {
    await out.close();
  }
}
