import { createManifestEditor } from "./metadata.js";

export function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length > 50)
    throw new Error("Use up to 50 tags.");
  const values = tags
    .map((tag) => {
      if (typeof tag !== "string") throw new Error("Tags must be text.");
      const value = tag
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (value.length > 50 || /[\x00-\x1f,]/.test(value))
        throw new Error("Tags must be under 51 characters, without commas.");
      return value;
    })
    .filter(Boolean);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function createTagEditor(
  catalog,
  root,
  edit = createManifestEditor(catalog, root),
) {
  return (ids, values, mode = "replace") => {
    return edit(ids, (item) => {
      if (!["add", "remove", "replace"].includes(mode))
        throw new Error("Unknown tag action.");
      const tags = normalizeTags(values),
        old = normalizeTags(item.tags || []);
      const next = normalizeTags(
        mode === "add"
          ? [...new Set([...old, ...tags])]
          : mode === "remove"
            ? old.filter((t) => !tags.includes(t))
            : tags,
      );
      return { ...item, tags: next };
    });
  };
}
