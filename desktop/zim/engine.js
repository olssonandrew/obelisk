import { Worker } from "node:worker_threads";
import { zimHeader } from "./header.js";

export async function openZim(filename) {
  const header = await zimHeader(filename);
  const worker = new Worker(new URL("./worker.cjs", import.meta.url), {
    workerData: { filename },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  const pending = new Map();
  let sequence = 0,
    closed = false;
  function close(
    reason = new Error("The reader was closed. Open the archive again."),
  ) {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    pending.clear();
    void worker.terminate();
  }
  worker.on("error", () =>
    close(
      new Error(
        "The ZIM reader stopped. The file may be incomplete or unsupported.",
      ),
    ),
  );
  worker.on("exit", () => close());
  worker.on("message", ({ id, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(new Error(error)) : p.resolve(value);
  });
  function call(action, input) {
    if (closed)
      return Promise.reject(
        new Error("The reader was closed. Open the archive again."),
      );
    if (pending.size >= 128)
      return Promise.reject(
        new Error("The reader is busy. Try again shortly."),
      );
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () =>
          close(
            new Error(
              "The archive took too long to respond. Open it again to retry.",
            ),
          ),
        30000,
      );
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, action, input });
    });
  }
  try {
    const info = { ...header, ...(await call("info")) };
    return {
      info,
      close,
      entry(name) {
        if (
          typeof name !== "string" ||
          !name ||
          name.length > 4096 ||
          /[\0\\]/.test(name)
        )
          return Promise.reject(new Error("Invalid article path."));
        return call("entry", name);
      },
      search(text, mode = "titles") {
        if (
          typeof text !== "string" ||
          text.length > 256 ||
          !["titles", "fulltext"].includes(mode)
        )
          return Promise.reject(
            new Error("Invalid search. Use up to 256 characters."),
          );
        return text.trim()
          ? call("search", { text: text.trim(), mode })
          : Promise.resolve([]);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
