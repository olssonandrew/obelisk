/**
 * Saving and reopening web pages.
 *
 * Saving: the page loads in a hidden, sandboxed browser whose every request passes
 * through `capture`, which fetches it, records the response into a WACZ, and hands
 * it on. Nothing is rewritten, so the saved copy holds what the site actually sent.
 *
 * Reopening: the page loads in a second kind of browser whose requests are answered
 * only from that file. Its network is switched off as well, so a saved page cannot
 * load, send, or look up anything, whatever its scripts try.
 */
import { app, BrowserWindow, WebContentsView, session, ipcMain, net } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWaczWriter, openWacz } from "../packages/core/wacz.js";
import { waybackRaw, fromWayback, snapshotDate, addressGuesses } from "../packages/sources/web.js";
import { transferError } from "../packages/core/transfer-errors.js";
import { safeFilename } from "../packages/core/archive.js";
import { mediaOf } from "../packages/types/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 ** 2,
  MAX_FILE = 40 * MB,
  MAX_TOTAL = 400 * MB,
  MAX_FILES = 3000,
  BAR = 46;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bodiless = (status) => [101, 204, 205, 304].includes(status);
const dropped =
  /^(set-cookie|content-encoding|content-length|transfer-encoding|connection|keep-alive|strict-transport-security|alt-svc|report-to|nel|content-security-policy-report-only)$/i;

/** No camera, location, notifications, downloads or anything else a page might ask for. */
function lockDown(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}
function pageWindowOptions(ses, extra = {}) {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    disableDialogs: true,
    spellcheck: false,
    ...extra,
  };
}
function reply(status, statusText, pairs, body) {
  const headers = new Headers();
  for (const [key, value] of pairs)
    if (!dropped.test(key))
      try {
        headers.append(key, value);
      } catch {}
  const safe = status >= 200 && status <= 599 ? status : 502;
  return new Response(bodiless(safe) ? null : body, { status: safe, statusText, headers });
}
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
/** The Wayback Machine returns the site's own headers under an `x-archive-orig-` prefix. */
function originalHeaders(headers) {
  const out = [["Content-Type", headers.get("content-type") || "application/octet-stream"]];
  for (const [key, value] of headers) {
    const name = /^x-archive-orig-(.+)$/i.exec(key)?.[1];
    if (name && !dropped.test(name) && !/^(content-type|content-security-policy|x-frame-options|location)$/i.test(name))
      out.push([name, value]);
  }
  return out;
}
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function notSaved(url) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not saved</title><style>body{font:15px/1.6 -apple-system,"Segoe UI",sans-serif;background:#141218;color:#e9e6f0;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:520px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{color:#a39db3;margin:0 0 12px}code{display:block;word-break:break-all;background:#1e1b26;border-radius:8px;padding:10px 12px;color:#c9c3d8;font-size:12.5px}</style><main><h1>This page wasn’t saved</h1><p>The saved copy holds one page and what it needed to display. This link leads somewhere that was not part of it, and saved pages never load anything from the internet.</p><code>${escapeHtml(url)}</code></main>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    },
  );
}

/** Where a Wayback address points, without downloading it. */
export function waybackProbe(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "HEAD", url, redirect: "manual" });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
      request.abort();
    };
    const timer = setTimeout(() => finish(reject, new Error("Timed out")), 20000);
    request.on("redirect", (status, method, location) => finish(resolve, { status, location }));
    request.on("response", (response) => finish(resolve, { status: response.statusCode, location: null }));
    request.on("error", (error) => finish(reject, error));
    request.end();
  });
}
export function createWebArchive({ getLibrary }) {
  const captures = new Set(),
    viewers = new Map();
  let inline = null;
  const software = `Obelisk ${app.getVersion()}`;
  const agent = () =>
    session.defaultSession
      .getUserAgent()
      .replace(/\s(Electron|Obelisk|obelisk)\/\S+/g, "");

  // Shared by every Wayback copy being saved, however many are queued.
  const waybackGate = limiter(4);
  async function transfer({ job, temporaryPath, signal, update }) {
    const failIfStopped = () => {
      if (signal.aborted) throw new Error("Paused");
    };
    const userAgent = agent();
    let stamp = job.snapshot || null,
      start = job.url;
    update({
      phase: stamp ? "Asking the Wayback Machine" : "Opening the page",
      bytes: 0,
      total: null,
    });
    // Follow redirects first so the page loads at its real address.
    if (stamp) {
      // Follow "the nearest capture is…" and any redirect the page made when captured.
      let at = waybackRaw(stamp, job.url),
        found = false;
      for (let hop = 0; hop < 6 && !found; hop++) {
        let answer;
        try {
          answer = await waybackProbe(at);
        } catch {
          failIfStopped();
          throw transferError("The Wayback Machine could not be reached.", "offline", { host: "web.archive.org" });
        }
        failIfStopped();
        const next = answer.location && fromWayback(new URL(answer.location, at).href);
        if (next) at = waybackRaw(next.timestamp, next.url);
        else if (answer.status === 200) found = true;
        else if ([429, 503].includes(answer.status))
          throw transferError("The Wayback Machine asked Obelisk to slow down.", "busy", { host: "web.archive.org" });
        else throw transferError(`The Wayback Machine has no usable copy of this page near that date (HTTP ${answer.status}).`, "gone", { host: "web.archive.org" });
      }
      ({ timestamp: stamp, url: start } = fromWayback(at));
    } else {
      let first;
      // An address typed by hand may need `www.` or plain http to answer.
      for (const address of addressGuesses(job.url)) {
        try {
          first = await fetch(address, {
            headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          });
          break;
        } catch {
          failIfStopped();
        }
      }
      if (!first)
        throw transferError(
          "This page could not be reached. Check the address, or try its Wayback Machine copy if it has been taken down.",
          "offline",
        );
      await first.body?.cancel().catch(() => {});
      start = first.url || start;
      // An error here is not final: some sites refuse anything but a real browser.
      if (first.ok && !/html|xml/i.test(first.headers.get("content-type") || "text/html"))
        throw new Error("This link is a file, not a page. Use “Save file” for it instead.");
    }

    const ses = session.fromPartition(`capture-${randomUUID()}`);
    lockDown(ses);
    ses.setUserAgent(userAgent);
    const writer = await createWaczWriter(temporaryPath, { software });
    const gate = stamp ? waybackGate : limiter(16),
      statuses = new Map();
    let inflight = 0,
      quietSince = Date.now(),
      finished = false,
      win;
    async function capture(request) {
      inflight++;
      try {
        const url = request.url.split("#")[0],
          get = request.method === "GET";
        if (signal.aborted || finished) return new Response(null, { status: 503 });
        if (stamp && !get) return new Response(null, { status: 404 });
        const headers = new Headers(stamp ? {} : request.headers);
        headers.delete("range");
        if (stamp) headers.set("Accept", request.headers.get("accept") || "*/*");
        const response = await gate(async () => {
          for (let attempt = 0; ; attempt++) {
            const answer = await ses.fetch(stamp ? waybackRaw(stamp, url) : url, {
              method: request.method,
              headers,
              ...(get || request.method === "HEAD" ? {} : { body: request.body, duplex: "half" }),
              bypassCustomProtocolHandlers: true,
              signal,
            });
            // The Internet Archive asks eager clients to slow down.
            if (!stamp || ![429, 503].includes(answer.status) || attempt >= 2) return answer;
            await answer.body?.cancel().catch(() => {});
            await sleep(2500 * (attempt + 1));
          }
        });
        const chunks = [];
        let size = 0;
        if (response.body)
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_FILE) {
              await response.body.cancel().catch(() => {});
              return new Response(null, { status: 502 });
            }
            chunks.push(chunk);
          }
        const body = Buffer.concat(chunks),
          pairs = (stamp ? originalHeaders(response.headers) : [...response.headers]).filter(
            ([key]) => !dropped.test(key),
          ),
          memento = stamp && Date.parse(response.headers.get("memento-datetime") || "");
        statuses.set(url, response.status);
        if (get && writer.bytes + size <= MAX_TOTAL && writer.count < MAX_FILES)
          writer.response({
            url,
            date: memento ? new Date(memento) : new Date(),
            status: response.status,
            statusText: response.statusText,
            headers: pairs,
            body,
          });
        return reply(response.status, response.statusText, pairs, body);
      } catch {
        return new Response(null, { status: 502 });
      } finally {
        inflight--;
        quietSince = Date.now();
      }
    }
    const idle = async (quiet, limit) => {
      const deadline = Date.now() + limit;
      while (Date.now() < deadline && (inflight > 0 || Date.now() - quietSince < quiet)) {
        failIfStopped();
        update({ phase: `Saving the page · ${writer.count} files`, bytes: writer.bytes });
        await sleep(200);
      }
    };
    const stop = () => {
      if (win && !win.isDestroyed()) win.destroy();
    };
    signal.addEventListener("abort", stop);
    ses.protocol.handle("http", capture);
    ses.protocol.handle("https", capture);
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: pageWindowOptions(ses, { backgroundThrottling: false }),
      });
      captures.add(win);
      const page = win.webContents;
      page.setAudioMuted(true);
      page.setWindowOpenHandler(() => ({ action: "deny" }));
      page.on("will-prevent-unload", (event) => event.preventDefault());
      const inPage = (code, limit = 8000) =>
        Promise.race([page.executeJavaScript(code, true), sleep(limit).then(() => null)]).catch(
          () => null,
        );
      let loadError = null;
      await Promise.race([
        page.loadURL(start).catch((error) => {
          if (!/ERR_ABORTED/.test(error.message)) loadError = error;
        }),
        sleep(45000),
      ]);
      failIfStopped();
      const address = () => (page.getURL() || start).split("#")[0];
      const status = statuses.get(address());
      if (!writer.count || (loadError && !status))
        throw new Error("This page could not be loaded. Check the address and your connection.");
      if (status >= 400)
        throw new Error(
          stamp
            ? `The Wayback Machine’s copy of this page is an error page (HTTP ${status}). Try another date.`
            : `This page answered with an error (HTTP ${status}). If it has been taken down, try its Wayback Machine copy.`,
        );
      await idle(1200, 15000);
      // Scroll to the bottom and back so images that wait to be seen get loaded too.
      await inPage(
        `new Promise((done) => { for (const node of document.querySelectorAll("img[loading=lazy],iframe[loading=lazy]")) node.loading = "eager"; let n = 0; const step = Math.max(400, innerHeight * 0.9); const timer = setInterval(() => { scrollBy(0, step); if (++n > 250 || innerHeight + scrollY >= document.documentElement.scrollHeight - 2) { clearInterval(timer); scrollTo(0, 0); done(true); } }, 90); })`,
        30000,
      );
      failIfStopped();
      await idle(1200, 12000);
      // Other sizes of the same pictures, so the copy still looks right on another screen.
      const extras = await inPage(
        `[...new Set([...document.querySelectorAll("img[srcset],source[srcset]")].flatMap((n) => [n.getAttribute("src") || "", ...n.srcset.split(",").map((part) => part.trim().split(/\\s+/)[0])].filter(Boolean).map((u) => { try { return new URL(u, document.baseURI).href } catch { return "" } })).filter((u) => /^https?:/.test(u)))].slice(0, 200)`,
      );
      await Promise.all(
        (Array.isArray(extras) ? extras : [])
          .filter((url) => typeof url === "string" && !writer.has(url.split("#")[0]))
          .map((url) => capture(new Request(url, { headers: { Accept: "image/*,*/*;q=0.8" } }))),
      );
      await idle(600, 8000);
      failIfStopped();
      const facts =
        (await inPage(
          `({ title: document.title, text: (document.body?.innerText || "").slice(0, 400000), description: document.querySelector('meta[name="description"],meta[property="og:description"]')?.content || "" })`,
        )) || {};
      const url = address(),
        host = new URL(url).hostname.replace(/^www\./, ""),
        // A page from a collection keeps the name its collection gives it.
        named = (job.source?.collection && job.title) || String(facts.title || page.getTitle() || host).trim().slice(0, 180) || host,
        // Copies of one page from different years need telling apart at a glance.
        title = stamp ? `${named} · ${snapshotDate(stamp).toISOString().slice(0, 10)}` : named;
      update({ phase: "Taking a picture of the page" });
      try {
        const shot = await page.capturePage();
        if (!shot.isEmpty())
          writer.resource({
            url: `urn:thumbnail:${url}`,
            mime: "image/jpeg",
            body: shot.resize({ width: 960 }).toJPEG(82),
          });
      } catch {}
      failIfStopped();
      finished = true;
      const date = stamp ? snapshotDate(stamp) : new Date(),
        done = await writer.finish({ url, title, text: String(facts.text || ""), date });
      update({
        title,
        // Shorten the page's name, never the date that tells copies apart.
        filename: safeFilename(`${named.slice(0, 70).trim()}${stamp ? ` ${snapshotDate(stamp).toISOString().slice(0, 10)}` : ""}.wacz`),
        description: String(facts.description || "").trim().slice(0, 4000),
        bytes: done.bytes,
        total: done.bytes,
        phase: null,
        finalUrl: url,
        source: {
          ...job.source,
          provider: stamp ? "Wayback Machine" : host,
          url,
          capturedAt: date.toISOString(),
          capturedFrom: stamp ? "wayback" : "live",
          files: done.responses,
          ...(stamp ? { snapshot: stamp } : {}),
        },
      });
    } finally {
      signal.removeEventListener("abort", stop);
      if (!finished) await writer.discard();
      finished = true;
      if (win) {
        captures.delete(win);
        stop();
      }
      ses.protocol.unhandle("http");
      ses.protocol.unhandle("https");
      void ses.clearStorageData().catch(() => {});
    }
  }

  async function saved(id) {
    const { item, filename } = await getLibrary().resolveItem(id);
    if (mediaOf(item.filename) !== "web")
      throw new Error("This file is not a saved web page.");
    return { item, archive: await openWacz(filename) };
  }
  const homeOf = (archive) =>
    archive.pages[0]?.url ||
    archive.info.mainPageURL ||
    archive.urls().find((url) => /^https?:/.test(url));

  /** The screenshot stored inside the file when the page was saved. */
  async function thumbnail(id) {
    const { archive } = await saved(id);
    try {
      const home = homeOf(archive),
        shot = home && (await archive.get(`urn:thumbnail:${home}`));
      const mime = shot?.headers.find(([key]) => /^content-type$/i.test(key))?.[1];
      if (!shot || shot.body.length > 2 * MB || !/^image\/(jpeg|png|webp)$/.test(mime || ""))
        return null;
      return `data:${mime};base64,${shot.body.toString("base64")}`;
    } finally {
      await archive.close();
    }
  }
  async function info(id) {
    const { archive } = await saved(id);
    try {
      const page = archive.pages[0];
      return {
        url: homeOf(archive) || "",
        title: page?.title || archive.info.title || "",
        captured: page?.ts || archive.info.mainPageDate || "",
        files: archive.size,
        pages: archive.pages.length,
      };
    } finally {
      await archive.close();
    }
  }

  /**
   * Loads one saved page into an isolated view on `host.parent`. The caller decides
   * where the view sits; the page only ever sees what is inside the file.
   */
  async function start(id, host) {
    const { item, archive } = await saved(id);
    const home = homeOf(archive);
    if (!home) {
      await archive.close();
      throw new Error("This file has no pages to show.");
    }
    const ses = session.fromPartition(`saved-${randomUUID()}`);
    lockDown(ses);
    // Belt and braces: even a request that slipped past `serve` has nowhere to go.
    ses.enableNetworkEmulation({ offline: true });
    await ses.setProxy({ proxyRules: "127.0.0.1:1", proxyBypassRules: "<-loopback>" });
    const viewer = { id, item, scripts: true, mainUrl: home, view: null, bounds: null, closed: false };
    async function serve(request) {
      const url = request.url.split("#")[0];
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
      let hit = null,
        at = url;
      try {
        // Files from other tools store redirects as records; follow them inside the file.
        for (let hops = 0; hops < 6; hops++) {
          hit = await archive.get(at);
          const next = hit && hit.status >= 300 && hit.status < 400 &&
            hit.headers.find(([key]) => /^location$/i.test(key))?.[1];
          if (!next) break;
          at = new URL(next, at).href.split("#")[0];
        }
      } catch {
        hit = null;
      }
      if (!hit || (hit.status >= 300 && hit.status < 400))
        return url === viewer.mainUrl ? notSaved(url) : new Response(null, { status: 404 });
      const pairs = hit.headers.filter(([key]) => !/^(location|accept-ranges|content-range)$/i.test(key));
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") || "");
      if (range && hit.status === 200 && Number(range[1]) < hit.body.length) {
        const from = Number(range[1]),
          to = Math.min(hit.body.length - 1, range[2] ? Number(range[2]) : hit.body.length - 1);
        return reply(206, "Partial Content",
          [...pairs, ["Accept-Ranges", "bytes"], ["Content-Range", `bytes ${from}-${to}/${hit.body.length}`]],
          hit.body.subarray(from, to + 1));
      }
      return reply(hit.status, "", pairs, hit.body);
    }
    ses.protocol.handle("http", serve);
    ses.protocol.handle("https", serve);

    const send = () => {
      const page = viewer.view?.webContents;
      if (viewer.closed || !page || page.isDestroyed()) return;
      const url = page.getURL() || viewer.mainUrl;
      host.state({
        url,
        title: page.getTitle() || item.title,
        back: page.navigationHistory.canGoBack(),
        forward: page.navigationHistory.canGoForward(),
        loading: page.isLoading(),
        scripts: viewer.scripts,
        saved: archive.has(url),
        captured: archive.pages.find((p) => p.url === url.split("#")[0])?.ts ||
          archive.pages[0]?.ts || archive.info.mainPageDate || item.source?.capturedAt || "",
        wayback: item.source?.capturedFrom === "wayback",
        files: archive.size,
      });
    };
    const layout = () => {
      if (!viewer.view) return;
      viewer.view.setVisible(!!viewer.bounds);
      if (viewer.bounds) viewer.view.setBounds(viewer.bounds);
    };
    function mount(address) {
      if (viewer.view) {
        host.parent.removeChildView(viewer.view);
        viewer.view.webContents.close();
      }
      const view = new WebContentsView({
        webPreferences: pageWindowOptions(ses, { javascript: viewer.scripts }),
      });
      const page = view.webContents;
      viewer.view = view;
      page.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) setImmediate(() => go(url));
        return { action: "deny" };
      });
      page.on("will-navigate", (event, url) => {
        if (!/^https?:/i.test(event.url ?? url)) event.preventDefault();
      });
      page.on("did-start-navigation", (event, url, inPlace, isMainFrame) => {
        if (event.isMainFrame ?? isMainFrame) viewer.mainUrl = String(event.url ?? url).split("#")[0];
      });
      page.on("will-prevent-unload", (event) => event.preventDefault());
      page.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape" && host.escape) host.escape();
      });
      for (const name of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"])
        page.on(name, send);
      host.parent.addChildView(view);
      layout();
      go(address);
    }
    function go(address) {
      const page = viewer.view?.webContents;
      if (!page || page.isDestroyed()) return;
      viewer.mainUrl = address.split("#")[0];
      page.loadURL(address).catch(() => {});
    }
    viewer.place = (bounds) => {
      viewer.bounds = bounds;
      layout();
    };
    viewer.command = (name) => {
      const page = viewer.view?.webContents;
      if (!page || page.isDestroyed()) return;
      if (name === "back" && page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
      else if (name === "forward" && page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
      else if (name === "home") go(home);
      else if (name === "scripts") {
        viewer.scripts = !viewer.scripts;
        mount(page.getURL() || home);
      } else if (name === "ready") send();
    };
    viewer.close = () => {
      if (viewer.closed) return;
      viewer.closed = true;
      try {
        host.parent.removeChildView(viewer.view);
      } catch {}
      try {
        viewer.view?.webContents.close();
      } catch {}
      ses.protocol.unhandle("http");
      ses.protocol.unhandle("https");
      void archive.close().catch(() => {});
      void ses.clearStorageData().catch(() => {});
    };
    mount(home);
    return viewer;
  }

  /** A saved page in a window of its own, with the toolbar above it. */
  async function open(id) {
    const existing = [...viewers.values()].find((viewer) => viewer.id === id);
    if (existing) return void existing.win.focus();
    const { item } = await getLibrary().resolveItem(id);
    const win = new BrowserWindow({
      width: 1240,
      height: 880,
      minWidth: 560,
      minHeight: 400,
      title: item.title,
      backgroundColor: "#141218",
      webPreferences: {
        preload: path.join(here, "web-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    const chrome = win.webContents;
    chrome.setWindowOpenHandler(() => ({ action: "deny" }));
    chrome.on("will-navigate", (event) => event.preventDefault());
    await win.loadURL("obelisk://app/web/viewer.html");
    let viewer;
    try {
      viewer = await start(id, {
        parent: win.contentView,
        state(state) {
          if (win.isDestroyed()) return;
          win.setTitle(state.title);
          chrome.send("saved:state", state);
        },
      });
    } catch (error) {
      win.destroy();
      throw error;
    }
    viewer.win = win;
    viewers.set(chrome.id, viewer);
    const layout = () => {
      const [width, height] = win.getContentSize();
      viewer.place({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
    };
    layout();
    win.on("resize", layout);
    win.on("closed", () => {
      viewers.delete(chrome.id);
      viewer.close();
    });
  }

  /**
   * A saved page inside the app's own viewer. The app's page reports where the page
   * should sit and draws the toolbar; one is shown at a time.
   */
  async function embed(id, win) {
    closeInline();
    const token = randomUUID();
    const viewer = await start(id, {
      parent: win.contentView,
      state: (state) => !win.isDestroyed() && win.webContents.send("saved:inline-state", { token, ...state }),
      escape: () => !win.isDestroyed() && win.webContents.send("saved:inline-escape", token),
    });
    viewer.win = win;
    viewer.token = token;
    // Another page may have been asked for while this one was opening.
    if (inline) inline.close();
    inline = viewer;
    return { token };
  }
  const own = (token) => (inline?.token === token ? inline : null);
  function placeInline(token, bounds) {
    const viewer = own(token);
    if (!viewer) return;
    const zoom = viewer.win.webContents.getZoomFactor();
    const box = bounds && {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom)),
    };
    viewer.place(box && box.width && box.height ? box : null);
  }
  function commandInline(token, name) {
    if (!["back", "forward", "home", "scripts", "ready"].includes(name)) return;
    own(token)?.command(name);
  }
  function closeInline(token) {
    if (!inline || (token && inline.token !== token)) return;
    inline.close();
    inline = null;
  }

  ipcMain.handle("saved:command", (event, name) => {
    const viewer = viewers.get(event.sender.id);
    if (
      !viewer ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== "obelisk://app/web/viewer.html" ||
      !["back", "forward", "home", "scripts", "ready"].includes(name)
    )
      throw new Error("This action is only available in a saved page window.");
    viewer.command(name);
  });

  return {
    transfer,
    open,
    embed,
    placeInline,
    commandInline,
    closeInline,
    thumbnail,
    info,
    closeAll() {
      closeInline();
      for (const win of captures) if (!win.isDestroyed()) win.destroy();
      for (const viewer of [...viewers.values()]) if (!viewer.win.isDestroyed()) viewer.win.destroy();
    },
  };
}
