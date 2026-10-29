import path from "node:path";
import { realpath, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hasKind } from "../types/index.js";

/** All user metadata edits share one queue and commit manifests before the catalog. */
export function createManifestEditor(catalog, root) {
  let queue = Promise.resolve();
  // `edited: false` for what the app records about the file itself (its checksum),
  // which isn't an edit to its details.
  return (ids, update, { edited = true } = {}) => {
    const task = queue
      .catch(() => {})
      .then(async () => {
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 1000 ||
          ids.some((id) => typeof id !== "string")
        )
          throw new Error("Select between 1 and 1,000 files.");
        const entries = await Promise.all(
          [...new Set(ids)].map(async (id) => {
            const item = catalog.get(id);
            if (!item?.path)
              throw new Error("File is no longer in this archive.");
            const manifest = await realpath(
              path.resolve(
                root,
                item.manifestPath ||
                  path.join(path.dirname(item.path), "item.json"),
              ),
            );
            if (!manifest.startsWith(root + path.sep))
              throw new Error("Manifest is outside this archive.");
            const saved = JSON.parse(await readFile(manifest, "utf8"));
            if (saved.id !== id)
              throw new Error(
                "The file's metadata has changed. Check the archive first.",
              );
            const next = update({ ...item });
            return {
              item: edited ? { ...next, metadataUpdatedAt: new Date().toISOString() } : next,
              manifest,
            };
          }),
        );
        for (const { item, manifest } of entries) {
          const temporary = manifest + "." + randomUUID() + ".tmp";
          try {
            await writeFile(temporary, JSON.stringify(item, null, 2) + "\n", {
              flag: "wx",
            });
            await rename(temporary, manifest);
            catalog.put(item);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        return entries.map((e) => e.item);
      });
    queue = task;
    return task;
  };
}
const textFields = { creator: 200, created: 60, rights: 500 };
export function metadataPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid file details.");
  const allowed = [
    "title",
    "description",
    "favorite",
    "rating",
    "kind",
    ...Object.keys(textFields),
  ];
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new Error("Unsupported metadata field.");
  const patch = {};
  if (Object.hasOwn(value, "title")) {
    if (typeof value.title !== "string") throw new Error("Enter a title.");
    patch.title = value.title.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!patch.title || patch.title.length > 300)
      throw new Error("Use a title of 1–300 characters.");
  }
  if (Object.hasOwn(value, "description")) {
    if (
      typeof value.description !== "string" ||
      value.description.length > 20000
    )
      throw new Error("Keep descriptions under 20,001 characters.");
    patch.description = value.description.trim();
  }
  if (Object.hasOwn(value, "favorite")) {
    if (typeof value.favorite !== "boolean")
      throw new Error("Invalid favorite value.");
    patch.favorite = value.favorite;
  }
  if (Object.hasOwn(value, "rating")) {
    if (!Number.isInteger(value.rating) || value.rating < 0 || value.rating > 5)
      throw new Error("Rate files from 0 to 5.");
    patch.rating = value.rating;
  }
  if (Object.hasOwn(value, "kind")) {
    if (typeof value.kind !== "string" || !/^[a-z]{0,20}$/.test(value.kind))
      throw new Error("Unknown kind.");
    patch.kind = value.kind;
  }
  for (const [key, limit] of Object.entries(textFields)) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "string")
      throw new Error("Invalid file details.");
    patch[key] = value[key].normalize("NFC").replace(/\s+/g, " ").trim();
    if (patch[key].length > limit)
      throw new Error(`Keep this field under ${limit + 1} characters.`);
  }
  return patch;
}
/** The first edit of each descriptive field keeps the value it replaced. */
export function applyMetadata(item, patch) {
  const original = { ...item.originalMetadata };
  for (const key of ["title", "description", ...Object.keys(textFields)])
    if (
      Object.hasOwn(patch, key) &&
      patch[key] !== (item[key] || "") &&
      !Object.hasOwn(original, key)
    )
      original[key] = item[key] || "";
  // A kind only means something on the shelf that defines it.
  if (patch.kind && !hasKind(item.type, patch.kind))
    throw new Error("That kind does not belong to this type of file.");
  const next = {
    ...item,
    ...(Object.keys(original).length ? { originalMetadata: original } : {}),
    ...patch,
  };
  if (patch.kind === "") delete next.kind;
  return next;
}
