import { el } from "./bridge.js";
export const needsAttention = (item) =>
  (item.fileState && item.fileState !== "ok") || item.integrity === "changed";
export function libraryViews(getState, onChange) {
  let current = "all";
  const labels = {
    all: "Library",
    favorites: "Favorites",
    recent: "Recently added",
    "needs-details": "Untagged",
    attention: "Needs attention",
  };
  // Dates are ISO strings, so comparing text is enough and far cheaper than parsing.
  const weekAgo = () => new Date(Date.now() - 7 * 86400000).toISOString();
  let since = weekAgo(),
    counted = { items: null, counts: {} };
  setInterval(() => (since = weekAgo()), 60000);
  const matches = (item, kind = current) =>
    kind === "favorites"
      ? item.favorite === true
      : kind === "recent"
        ? String(item.acquiredAt) > since
        : kind === "needs-details"
          ? !item.tags?.length
          : kind === "attention"
            ? needsAttention(item)
            : true;
  const buttons = [...document.querySelectorAll("[data-quick]")];
  buttons.forEach(
    (button) =>
      (button.onclick = () => {
        current = button.dataset.quick;
        onChange();
      }),
  );
  const slider = document.querySelector("#thumbnail-size");
  slider.value = localStorage.getItem("thumbnailSize") || "195";
  const scale = () => {
    document.documentElement.style.setProperty(
      "--tile-size",
      `${slider.value}px`,
    );
    localStorage.setItem("thumbnailSize", slider.value);
  };
  slider.oninput = scale;
  scale();
  return {
    matches,
    reset() {
      current = "all";
    },
    get current() {
      return current;
    },
    get title() {
      return labels[current];
    },
    sync(active) {
      // Counts change only with the items, not with every search keystroke.
      const items = getState().items;
      if (counted.items !== items)
        counted = {
          items,
          counts: Object.fromEntries(
            buttons.map((b) => [b.dataset.quick, items.filter((i) => matches(i, b.dataset.quick)).length]),
          ),
        };
      for (const button of buttons) {
        const count = counted.counts[button.dataset.quick];
        button.classList.toggle(
          "active",
          active && current === button.dataset.quick,
        );
        button.querySelector("small").textContent = count || "";
        // Problems only earn a row while there is something to look at.
        if (button.dataset.quick === "attention")
          button.hidden = !count && current !== "attention";
      }
    },
    /** Chips for everything narrowing the grid beyond the pill selects. */
    summary({ query, show }) {
      const host = document.querySelector("#filter-summary");
      host.replaceChildren();
      if (current !== "all")
        host.append(
          el(
            "span",
            current === "recent"
              ? "Added in the last 7 days"
              : current === "needs-details"
                ? "Files without tags"
                : current === "attention"
                  ? "Missing, moved, or modified files"
                  : labels[current],
          ),
        );
      if (query) host.append(el("span", `Search: ${query}`));
      if (show) host.append(el("span", show));
      host.hidden = !host.childElementCount;
    },
  };
}
