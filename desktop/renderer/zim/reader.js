import DOMPurify from "dompurify";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search),
  token = params.get("token");
const base = `obelisk://zim/${token}/content/`;
const history = [];
let position = -1,
  current = "",
  navigation = 0,
  searchGeneration = 0,
  scale = 1;
let busy = false;
function syncTheme(doc = $("article").contentDocument) {
  const theme = document.documentElement.dataset.theme || "light";
  $("article").style.colorScheme = theme;
  if (doc) {
    const root = doc.documentElement;
    root.dataset.obeliskTheme = theme;
    // Use MediaWiki's own palette for article panels, headings, and tables.
    root.classList.remove(
      "skin-theme-clientpref-os",
      "skin-theme-clientpref-day",
      "skin-theme-clientpref-night",
    );
    root.classList.add(
      `skin-theme-clientpref-${theme === "dark" ? "night" : "day"}`,
    );
  }
}
new MutationObserver(() => syncTheme()).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
window.addEventListener("storage", (event) => {
  if (event.key === "theme") window.applyTheme?.();
});
function message(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}
function controls() {
  $("back").disabled = busy || position <= 0;
  $("forward").disabled = busy || position >= history.length - 1;
}
function entryURL(path) {
  return base + path.split("/").map(encodeURIComponent).join("/");
}
function internal(url) {
  return (
    url.origin === new URL(base).origin &&
    url.pathname.startsWith(`/${token}/content/`)
  );
}

function showHash(hash) {
  if (!hash) return;
  try {
    $("article")
      .contentDocument.getElementById(decodeURIComponent(hash.slice(1)))
      ?.scrollIntoView();
  } catch {}
}
async function go(address, historyIndex = null) {
  const target = new URL(address, current || base);
  if (!internal(target)) {
    message("That link is outside this saved archive.");
    return;
  }
  const turn = ++navigation;
  busy = true;
  controls();
  message("Loading article…");
  $("results").hidden = true;
  try {
    const response = await fetch(target.href);
    if (!response.ok) {
      let detail;
      try {
        detail = (await response.json()).error;
      } catch {}
      throw new Error(detail || "This page is not included in this archive.");
    }
    const resolved = new URL(response.url);
    resolved.hash = target.hash;
    const mime = response.headers.get("content-type") || "";
    if (!/html|xhtml/.test(mime))
      throw new Error(
        "This link is a file rather than an article. Use the archive’s original reader to open it.",
      );
    const source = await response.text();
    if (turn !== navigation) return;
    const clean = DOMPurify.sanitize(source, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["link"],
      ADD_ATTR: ["rel", "href"],
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "base",
        "meta",
      ],
      FORBID_ATTR: [
        "srcdoc",
        "autofocus",
        "autoplay",
        "ping",
        "target",
        "download",
      ],
    });
    const doc = new DOMParser().parseFromString(clean, "text/html");
    // The only possible asset source is the active ZIM. No web requests or script execution.
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' obelisk://zim; img-src obelisk://zim data:; font-src obelisk://zim data:; media-src obelisk://zim; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri obelisk://zim`;
    const baseElement = doc.createElement("base");
    baseElement.href = resolved.href;
    const charset = doc.createElement("meta");
    charset.charset = "utf-8";
    doc.head.prepend(policy, charset, baseElement);
    const style = doc.createElement("style");
    style.textContent = `html{height:auto!important;min-height:100%;background:#f8f9fa!important;color:#202122;color-scheme:light}html[data-obelisk-theme="dark"]{background:#101418!important;color:#eaecf0;color-scheme:dark}body{min-height:100vh;height:auto!important;background:inherit!important;color:inherit!important;box-sizing:border-box;max-width:1100px;margin:0 auto!important;padding:24px clamp(16px,4vw,44px)!important;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}pre{white-space:pre-wrap}a{cursor:pointer}table{max-width:100%}.infobox th{min-width:5em;overflow-wrap:normal}`;
    doc.head.append(style);
    syncTheme(doc);
    const title =
      doc.title || doc.querySelector("h1")?.textContent || params.get("title");
    current = resolved.href;
    if (historyIndex === null) {
      history.splice(position + 1);
      history.push(current);
      position = history.length - 1;
      if (history.length > 200) {
        history.shift();
        position--;
      }
    } else {
      position = historyIndex;
      history[position] = current;
    }
    $("location").textContent = title;
    $("article").onload = () => {
      const body = $("article").contentDocument;
      if (!body || turn !== navigation) return;
      syncTheme(body);
      body.documentElement.style.zoom = scale;
      body.addEventListener(
        "click",
        (event) => {
          const a = event.target.closest?.("a[href]");
          if (!a) return;
          event.preventDefault();
          event.stopPropagation();
          const next = new URL(a.getAttribute("href"), current);
          if (next.href.split("#")[0] === current.split("#")[0] && next.hash) {
            showHash(next.hash);
            return;
          }
          void go(next.href);
        },
        true,
      );
      body.addEventListener(
        "auxclick",
        (event) => event.preventDefault(),
        true,
      );
      showHash(resolved.hash);
    };
    $("article").srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
    message("");
  } catch (error) {
    if (turn === navigation) message(error.message);
  } finally {
    if (turn === navigation) {
      busy = false;
      controls();
    }
  }
}
async function search() {
  const q = $("query").value.trim(),
    turn = ++searchGeneration;
  if (!q) {
    $("results").hidden = true;
    return;
  }
  $("results").hidden = false;
  $("result-count").textContent = "Searching…";
  $("matches").replaceChildren();
  try {
    const response = await fetch(
      `obelisk://zim/${token}/search?q=${encodeURIComponent(q)}&mode=${$("mode").value}`,
    );
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || "Search is unavailable.");
    if (turn !== searchGeneration) return;
    $("result-count").textContent =
      rows.length === 40 ? "First 40 matches" : `${rows.length} matches`;
    if (!rows.length) {
      const p = document.createElement("p");
      p.textContent =
        $("mode").value === "fulltext"
          ? "No text matches. Try Titles if this edition has no full-text index."
          : "No matching titles. Try another word or search All text.";
      $("matches").append(p);
    }
    for (const row of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = row.title;
      button.onclick = () => go(entryURL(row.path));
      $("matches").append(button);
    }
  } catch (error) {
    if (turn === searchGeneration)
      $("result-count").textContent = error.message;
  }
}
$("search").onsubmit = (event) => {
  event.preventDefault();
  void search();
};
let debounce;
$("query").oninput = () => {
  clearTimeout(debounce);
  searchGeneration++;
  if (!$("query").value.trim()) $("results").hidden = true;
  else if ($("mode").value === "titles") debounce = setTimeout(search, 250);
};
$("mode").onchange = search;
$("close-results").onclick = () => {
  searchGeneration++;
  $("results").hidden = true;
};
$("back").onclick = () => {
  if (position > 0) void go(history[position - 1], position - 1);
};
$("forward").onclick = () => {
  if (position + 1 < history.length)
    void go(history[position + 1], position + 1);
};
$("home").onclick = () => {
  const home = params.get("home");
  if (home) void go(entryURL(home));
  else {
    $("query").focus();
    message("This archive has no welcome page. Search for an article above.");
  }
};
for (const [id, delta] of [
  ["smaller", -0.1],
  ["larger", 0.1],
])
  $(id).onclick = () => {
    scale = Math.min(1.8, Math.max(0.7, scale + delta));
    if ($("article").contentDocument)
      $("article").contentDocument.documentElement.style.zoom = scale;
  };
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("results").hidden = true;
});
$("home").click();
