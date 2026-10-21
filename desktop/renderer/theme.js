// Loaded before the stylesheets so a dark archive never flashes white.
(() => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const saved = localStorage.getItem("theme") || "dark";
    document.documentElement.dataset.theme =
      saved === "system" ? (media.matches ? "dark" : "light") : saved;
  };
  media.addEventListener("change", apply);
  window.applyTheme = apply;
  apply();
})();
