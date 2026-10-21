/** Adapter for the shared discovery screens. No HTTP server is involved. */
export async function sourceApi(route, options = {}) {
  const url = new URL(route, "https://local.invalid");
  const q = url.searchParams,
    input = options.body ? JSON.parse(options.body) : {};
  const refresh = q.get("refresh") === "1";
  switch (url.pathname) {
    case "/api/sources/status":
      return window.obelisk.source("status");
    case "/api/sources/wikipedia":
      return window.obelisk.source("wikipedia", {
        language: q.get("language"),
        query: q.get("query"),
        start: Number(q.get("start") || 0),
        refresh,
      });
    case "/api/sources/podcasts/search":
      return window.obelisk.source("podcastSearch", {
        query: q.get("q"),
        provider: q.get("provider"),
        refresh,
      });
    case "/api/sources/podcasts/feed":
      return window.obelisk.source("podcastFeed", {
        url: q.get("url"),
        refresh,
      });
    case "/api/sources/podcasts/follow":
      return window.obelisk.source("podcastFollow", input);
    case "/api/sources/maps":
      return window.obelisk.source("maps", { refresh });
    case "/api/sources/maps/acquire":
      return window.obelisk.source("acquireMap", input);
    case "/api/sources/acquire":
      return window.obelisk.source("acquire", input);
    default:
      throw new Error("Unknown source action.");
  }
}
export const el = (tag, text = "", cls = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export const size = (value) => {
  if (!value) return "0 B";
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};
export const fileURL = (item) =>
  `obelisk://archive/${encodeURIComponent(item.id)}`;
// A new cover gets a new address, so the window never shows the one it replaced.
const coverVersions = new Map();
export const bumpCover = (id) => coverVersions.set(id, (coverVersions.get(id) || 0) + 1);
/** A small copy of a photo, made once and kept with the archive. */
export const coverURL = (item) =>
  `obelisk://thumb/${encodeURIComponent(item.id)}?v=${String(item.sha256 || "").slice(0, 12)}.${coverVersions.get(item.id) || 0}`;
export const formatOf = (item) =>
  item.filename.includes(".") ? item.filename.split(".").pop().toUpperCase() : "FILE";
export const shortDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
};
/** Works without a clipboard permission prompt. */
export function copyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}
