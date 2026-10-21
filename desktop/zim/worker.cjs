// Runs the pinned, unmodified OpenZIM WASM build off the application's UI thread.
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
let listener, engine;
globalThis.self = globalThis;
self.addEventListener = (type, fn) => {
  if (type === "message") listener = fn;
};
// Upstream logs every read. Keep routine archive browsing out of the application log.
console.debug = () => {};
const runtime = require.resolve("./vendor/libzim-wasm.cjs");
require(runtime);
const ready = new Promise((resolve, reject) => {
  try {
    listener({
      data: {
        action: "init",
        files: [
          {
            path: workerData.filename,
            name: path.basename(workerData.filename),
            readMode: "electron",
          },
        ],
      },
      ports: [
        {
          postMessage() {
            engine = require.cache[runtime].exports;
            resolve();
          },
        },
      ],
    });
  } catch (error) {
    reject(error);
  }
});
// Access bindings directly after init so every C++ wrapper is explicitly released.
function entry(name) {
  let e, item, blob;
  try {
    e = engine.getEntryByPath(name);
    if (!e) return null;
    const title = e.getTitle();
    if (e.isRedirect()) {
      const target = e.getRedirectEntry();
      try {
        return { redirect: target.getPath(), title };
      } finally {
        target.delete();
      }
    }
    item = e.getItem(false);
    blob = item.getData();
    const view = blob.getContent();
    if (view.length > 32 * 1024 * 1024)
      throw new Error(
        "This entry is too large for the built-in reader (32 MB limit).",
      );
    return { title, mime: item.getMimetype(), content: new Uint8Array(view) };
  } finally {
    blob?.delete();
    item?.delete();
    e?.delete();
  }
}
function search(text, mode) {
  const results = [];
  const list = engine[mode === "fulltext" ? "search" : "suggest"](text, 40);
  try {
    for (let i = 0; i < list.size(); i++) {
      const e = list.get(i);
      try {
        results.push({ path: e.getPath(), title: e.getTitle() });
      } finally {
        e.delete();
      }
    }
    return results;
  } finally {
    list.delete();
  }
}
parentPort.on("message", async ({ id, action, input }) => {
  try {
    await ready;
    let value;
    if (action === "info") {
      try {
        value = { articles: engine.getArticleCount() };
      } catch {
        value = { articles: null };
      }
    } else if (action === "entry") value = entry(input);
    else if (action === "search") value = search(input.text, input.mode);
    else throw new Error("Unknown reader action.");
    parentPort.postMessage(
      { id, value },
      value?.content ? [value.content.buffer] : [],
    );
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error?.message || "The archive could not be read.",
    });
  }
});
