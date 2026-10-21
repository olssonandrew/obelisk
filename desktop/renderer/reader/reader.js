import JSZip from "jszip";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = new URL(
  "./pdf.worker.mjs",
  import.meta.url,
).href;
const query = new URLSearchParams(location.search),
  ext = query.get("ext");
const content = document.querySelector("#content"),
  status = document.querySelector("#status");
const previous = document.querySelector("#previous"),
  next = document.querySelector("#next");
const chapters = document.querySelector("#chapters"),
  position = document.querySelector("#position");
let page = 0,
  count = 1,
  textSize = 16,
  renderPage,
  revision = 0;
let blobs = [];
let openLink = () => {};
function fail(error) {
  status.hidden = false;
  status.textContent = error.message || "Unable to open this document.";
}
function xml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror"))
    throw new Error("This EPUB contains invalid XML.");
  return doc;
}
function relative(base, href) {
  try {
    const url = new URL(href, "https://book.invalid/" + base);
    if (url.origin !== "https://book.invalid") return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}
// Only local raster images and inert book markup enter the reading surface.
function clean(html) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "iframe",
      "object",
      "embed",
      "audio",
      "video",
      "source",
      "link",
      "meta",
    ],
    FORBID_ATTR: ["style", "srcset"],
  });
  for (const element of fragment.querySelectorAll("[src]"))
    element.removeAttribute("src");
  return fragment;
}
async function show() {
  const token = ++revision;
  previous.disabled = next.disabled = true;
  try {
    await renderPage(token);
    if (token !== revision) return;
    const empty = ext === "epub" && !content.textContent.trim() && !content.querySelector("img[src]");
    status.hidden = !empty;
    if (empty) status.textContent = "This section has no readable content. Choose another chapter.";
    position.textContent = `${page + 1} / ${count}`;
    chapters.value = String(page);
    content.scrollIntoView();
  } catch (error) {
    if (token === revision) fail(error);
  } finally {
    if (token === revision) {
      previous.disabled = page === 0;
      next.disabled = page === count - 1;
    }
  }
}
previous.onclick = () => {
  if (page > 0) {
    page--;
    show();
  }
};
next.onclick = () => {
  if (page < count - 1) {
    page++;
    show();
  }
};
chapters.onchange = () => {
  page = Number(chapters.value);
  show();
};
for (const [id, delta] of [
  ["smaller", -2],
  ["larger", 2],
])
  document.querySelector("#" + id).onclick = () => {
    textSize = Math.max(12, Math.min(28, textSize + delta));
    content.style.fontSize = textSize + "px";
  };
function scrollToAnchor(hash) {
  let name;
  try { name = decodeURIComponent(hash); } catch { return; }
  const target = [...content.querySelectorAll("[id], a[name]")].find(
    (element) => element.id === name || element.getAttribute("name") === name,
  );
  target?.scrollIntoView();
}
content.addEventListener("click", (event) => {
  const a = event.target.closest("a[href]");
  if (!a) return;
  event.preventDefault();
  const href = a.getAttribute("href");
  if (href.startsWith("#")) scrollToAnchor(href.slice(1));
  else openLink(href);
});
document.addEventListener("keydown", (event) => {
  if (ext !== "epub" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest("button, select, input, textarea, [contenteditable]") ||
      !getSelection().isCollapsed) return;
  const button = event.key === "ArrowLeft" ? previous : event.key === "ArrowRight" ? next : null;
  if (button && !button.disabled) {
    event.preventDefault();
    button.click();
  }
});
window.addEventListener("unload", () =>
  blobs.forEach((url) => URL.revokeObjectURL(url)),
);
try {
  const url = `obelisk://archive/${encodeURIComponent(query.get("item"))}`;
  chapters.hidden = true;
  if (ext === "pdf") {
    document.body.classList.add("pdf");
    document.querySelector("#smaller").hidden = document.querySelector(
      "#larger",
    ).hidden = true;
    const pdf = await getDocument({
      url,
      isEvalSupported: false,
      cMapUrl: new URL("./cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./standard_fonts/", import.meta.url).href,
      wasmUrl: new URL("./wasm/", import.meta.url).href,
    }).promise;
    count = pdf.numPages;
    renderPage = async (token) => {
      const sheet = await pdf.getPage(page + 1),
        viewport = sheet.getViewport({ scale: 2.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await sheet.render({ canvasContext: canvas.getContext("2d"), viewport })
        .promise;
      if (token === revision) content.replaceChildren(canvas);
    };
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error("The saved file could not be opened.");
    if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024)
      throw new Error(
        "This document is too large for the built-in reader (100 MB). Open it in your preferred reader.",
      );
    if (ext === "epub") {
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      const unpacked = Object.values(zip.files).reduce(
        (sum, file) => sum + (file._data?.uncompressedSize || 0),
        0,
      );
      if (unpacked > 200 * 1024 * 1024 || Object.keys(zip.files).length > 10000)
        throw new Error(
          "This EPUB is too large for the built-in reader. Open it in a dedicated EPUB reader.",
        );
      if (zip.file("META-INF/encryption.xml"))
        throw new Error(
          "This EPUB contains protected or obfuscated resources. Open it in a compatible EPUB reader.",
        );
      const read = async (name) => {
        const file = zip.file(name);
        if (!file) throw new Error("This EPUB is missing a required file.");
        const text = await file.async("string");
        if (text.length > 10 * 1024 * 1024)
          throw new Error("This chapter is too large for the built-in reader.");
        return text;
      };
      const container = xml(await read("META-INF/container.xml"));
      const packagePath = container
        .querySelector("rootfile")
        ?.getAttribute("full-path");
      if (!packagePath) throw new Error("This EPUB has no book manifest.");
      const packageDoc = xml(await read(packagePath));
      const items = new Map(
        [...packageDoc.querySelectorAll("manifest > item")].map((item) => [
          item.getAttribute("id"),
          item,
        ]),
      );
      const spine = [...packageDoc.querySelectorAll("spine > itemref")]
        .filter((item) => item.getAttribute("linear") !== "no")
        .map((item) => items.get(item.getAttribute("idref")))
        .filter(Boolean);
      count = spine.length;
      if (!count) throw new Error("This EPUB has no readable chapters.");
      chapters.hidden = false;
      spine.forEach((item, index) =>
        chapters.add(new Option(`Chapter ${index + 1}`, String(index))),
      );
      const chapterPaths = spine.map((item) =>
        relative(packagePath, item.getAttribute("href")),
      );
      openLink = (href) => {
        if (!href) return;
        const destination = relative(chapterPaths[page], href);
        const index = chapterPaths.indexOf(destination);
        if (index >= 0) {
          page = index;
          show().then(() => {
            const hash = href.split("#")[1];
            if (hash) scrollToAnchor(hash);
          });
        }
      };
      const navItem = [...items.values()].find((item) =>
        item.getAttribute("properties")?.split(/\s+/).includes("nav"),
      );
      const namedChapters = new Set();
      const labelChapter = (base, href, label) => {
        const index = chapterPaths.indexOf(relative(base, href));
        const title = label?.trim().replace(/\s+/g, " ").slice(0, 80);
        if (index >= 0 && title && !namedChapters.has(index)) {
          chapters.options[index].textContent = title;
          namedChapters.add(index);
        }
      };
      // A damaged optional table of contents must not prevent reading the book.
      try {
        if (navItem) {
          const navPath = relative(packagePath, navItem.getAttribute("href"));
          const nav = xml(await read(navPath));
          const toc = [...nav.querySelectorAll("nav")].find((element) =>
            (element.getAttribute("epub:type") || element.getAttribute("type") || "")
              .split(/\s+/).includes("toc"),
          ) || nav.querySelector("nav");
          for (const link of toc?.querySelectorAll("a[href]") || [])
            labelChapter(navPath, link.getAttribute("href"), link.textContent);
        }
        const ncxItem = items.get(packageDoc.querySelector("spine")?.getAttribute("toc")) ||
          [...items.values()].find((item) => item.getAttribute("media-type") === "application/x-dtbncx+xml");
        if (ncxItem) {
          const ncxPath = relative(packagePath, ncxItem.getAttribute("href"));
          const ncx = xml(await read(ncxPath));
          for (const point of ncx.querySelectorAll("navPoint")) {
            const target = point.querySelector("content")?.getAttribute("src");
            if (target) labelChapter(ncxPath, target, point.querySelector("navLabel")?.textContent);
          }
        }
      } catch {
        // Chapter headings remain available when navigation metadata is missing.
      }

      renderPage = async (token) => {
        const file = relative(packagePath, spine[page].getAttribute("href"));
        const raw = new DOMParser().parseFromString(
          await read(file),
          "text/html",
        );
        // Gutenberg covers wrap a raster image in SVG. Keep the image without
        // admitting active SVG markup into the document.
        for (const svg of raw.querySelectorAll("svg")) {
          const images = [...svg.querySelectorAll("image")].map((image) => {
            const img = raw.createElement("img");
            img.setAttribute("src", image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink", "href") || image.getAttribute("xlink:href") || "");
            img.alt = svg.querySelector("title")?.textContent || raw.title || "Book illustration";
            return img;
          });
          if (images.length) svg.replaceWith(...images);
        }
        // Keep image references attached to their element through sanitization.
        for (const img of raw.querySelectorAll("img"))
          img.setAttribute("data-book-src", img.getAttribute("src") || "");
        const fragment = clean(raw.body.innerHTML);
        const chapterBlobs = [];
        for (const img of fragment.querySelectorAll("img")) {
          const imagePath = relative(file, img.getAttribute("data-book-src") || "");
          img.removeAttribute("data-book-src");
          if (!imagePath || !/\.(png|jpe?g|gif|webp)$/i.test(imagePath))
            continue;
          const image = zip.file(imagePath);
          if (!image) continue;
          const bytes = await image.async("uint8array");
          if (bytes.length > 20 * 1024 * 1024) continue;
          const objectURL = URL.createObjectURL(
            new Blob([bytes], {
              type:
                "image/" + imagePath.split(".").pop().replace("jpg", "jpeg"),
            }),
          );
          chapterBlobs.push(objectURL);
          img.src = objectURL;
        }
        if (token === revision) {
          blobs.forEach((url) => URL.revokeObjectURL(url));
          blobs = chapterBlobs;
          content.replaceChildren(fragment);
          const heading = content.querySelector("h1,h2,h3")?.textContent;
          if (heading && !namedChapters.has(page))
            chapters.options[page].textContent = heading.slice(0, 80);
        } else chapterBlobs.forEach((url) => URL.revokeObjectURL(url));
      };
    } else {
      const text = await response.text();
      renderPage = async () => {
        if (ext === "md") content.replaceChildren(clean(marked.parse(text)));
        else {
          const pre = document.createElement("pre");
          pre.textContent = text;
          content.replaceChildren(pre);
        }
      };
      previous.hidden = next.hidden = true;
      position.hidden = true;
    }
  }
  await show();
} catch (error) {
  fail(error);
}
