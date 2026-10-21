import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Original, uncompressed legacy-format fixture: no downloaded Wikipedia content.
export async function writeZim(
  filename,
  {
    html = '<h1>Welcome</h1><a href="Second">Second article</a><img src="../I/pixel.svg">',
  } = {},
) {
  const entries = [
    { name: "A/Welcome", title: "Welcome", body: html, mime: 0 },
    {
      name: "A/Second",
      title: "Second",
      body: '<h1>Second</h1><a href="Welcome">Welcome</a>',
      mime: 0,
    },
    { name: "A/Café", title: "Café", body: "<h1>Café</h1>", mime: 0 },
    { name: "A/Alias", title: "Alias", redirect: "A/Second" },
    {
      name: "I/pixel.svg",
      title: "",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
      mime: 1,
    },
    {
      name: "M/Counter",
      title: "",
      body: "text/html=3;image/svg+xml=1",
      mime: 2,
    },
  ].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const mime = Buffer.from("text/html\0image/svg+xml\0text/plain\0\0");
  const header = Buffer.alloc(80);
  let offset = 80 + mime.length;
  const blobs = [];
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(e.redirect ? 12 : 16);
    d.writeUInt16LE(e.redirect ? 0xffff : e.mime);
    d[3] = e.name.charCodeAt(0);
    if (e.redirect)
      d.writeUInt32LE(
        entries.findIndex((x) => x.name === e.redirect),
        8,
      );
    else {
      d.writeUInt32LE(blobs.length, 12);
      blobs.push(Buffer.from(e.body));
    }
    const bytes = Buffer.concat([
      d,
      Buffer.from(e.name.slice(2) + "\0" + e.title + "\0"),
    ]);
    e.offset = offset;
    offset += bytes.length;
    return bytes;
  });
  const urlpos = offset,
    urlptr = Buffer.alloc(entries.length * 8);
  entries.forEach((e, i) => urlptr.writeBigUInt64LE(BigInt(e.offset), i * 8));
  offset += urlptr.length;
  const titlepos = offset,
    titles = Buffer.alloc(entries.length * 4);
  entries
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.name[0] + a.title),
        Buffer.from(b.name[0] + b.title),
      ),
    )
    .forEach((e, i) => titles.writeUInt32LE(e.i, i * 4));
  offset += titles.length;
  const clusterpos = offset,
    clusterptr = Buffer.alloc(8);
  offset += 8;
  clusterptr.writeBigUInt64LE(BigInt(offset));
  const offsets = Buffer.alloc((blobs.length + 1) * 4);
  let n = offsets.length;
  blobs.forEach((body, i) => {
    offsets.writeUInt32LE(n, i * 4);
    n += body.length;
  });
  offsets.writeUInt32LE(n, blobs.length * 4);
  const cluster = Buffer.concat([Buffer.from([1]), offsets, ...blobs]);
  offset += cluster.length;
  header.writeUInt32LE(0x044d495a);
  header.writeUInt16LE(6, 4);
  header.writeUInt32LE(entries.length, 24);
  header.writeUInt32LE(1, 28);
  header.writeBigUInt64LE(BigInt(urlpos), 32);
  header.writeBigUInt64LE(BigInt(titlepos), 40);
  header.writeBigUInt64LE(BigInt(clusterpos), 48);
  header.writeBigUInt64LE(80n, 56);
  header.writeUInt32LE(
    entries.findIndex((e) => e.name === "A/Welcome"),
    64,
  );
  header.writeUInt32LE(0xffffffff, 68);
  header.writeBigUInt64LE(BigInt(offset), 72);
  const data = Buffer.concat([
    header,
    mime,
    ...dirs,
    urlptr,
    titles,
    clusterptr,
    cluster,
  ]);
  await writeFile(
    filename,
    Buffer.concat([data, createHash("md5").update(data).digest()]),
  );
}
