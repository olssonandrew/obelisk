import { open } from "node:fs/promises";

/** Only locates the welcome entry. libzim owns decompression, indexing and reading. */
export async function zimHeader(filename) {
  const file = await open(filename, "r");
  try {
    const { size } = await file.stat();
    async function read(position, length) {
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position + length > size
      )
        throw new Error("This ZIM is incomplete or damaged.");
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, position)).bytesRead !== length)
        throw new Error("This ZIM is incomplete or damaged.");
      return bytes;
    }
    const h = await read(0, 80);
    if (h.readUInt32LE(0) !== 0x044d495a || ![5, 6].includes(h.readUInt16LE(4)))
      throw new Error("This file is not a supported ZIM archive.");
    const count = h.readUInt32LE(24),
      table = Number(h.readBigUInt64LE(32));
    if (!count || !Number.isSafeInteger(table) || table + count * 8 > size)
      throw new Error("This ZIM is incomplete or damaged.");
    let index = h.readUInt32LE(64);
    if (index === 0xffffffff) return { home: null };
    const visited = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (index >= count || visited.has(index))
        throw new Error("Invalid ZIM welcome page.");
      visited.add(index);
      const offset = Number(
        (await read(table + index * 8, 8)).readBigUInt64LE(),
      );
      const entry = await read(offset, Math.min(8192, size - offset));
      if (entry.length < 16) throw new Error("Invalid ZIM entry.");
      if (entry.readUInt16LE() === 0xffff) {
        index = entry.readUInt32LE(8);
        continue;
      }
      const end = entry.indexOf(0, 16);
      if (end < 0) throw new Error("Invalid ZIM entry path.");
      const name = entry.toString("utf8", 16, end);
      // Modern archives use namespace C internally, but libzim exposes bare paths.
      return {
        home:
          h.readUInt16LE(6) >= 1
            ? name
            : String.fromCharCode(entry[3]) + "/" + name,
      };
    }
    throw new Error("Too many ZIM welcome-page redirects.");
  } finally {
    await file.close();
  }
}
