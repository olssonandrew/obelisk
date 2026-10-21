import { randomUUID } from "node:crypto";
import { openZim } from "./engine.js";
const headers = {
  "Access-Control-Allow-Origin": "obelisk://app",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
export function createZimReader(getLibrary) {
  let active,
    generation = 0;
  function close(token) {
    if (token && token !== active?.token) return;
    generation++;
    active?.engine.close();
    active = null;
  }
  return {
    close,
    async open(id) {
      close();
      const current = generation;
      const library = getLibrary();
      const { filename, item } = await library.resolveItem(id);
      if (!/\.zim$/i.test(item.filename))
        throw new Error("Choose a ZIM archive.");
      const engine = await openZim(filename);
      if (current !== generation || library !== getLibrary()) {
        engine.close();
        throw new Error("Another archive was selected.");
      }
      const token = randomUUID();
      active = { engine, token };
      return { token, title: item.title, ...engine.info };
    },
    async response(request) {
      const url = new URL(request.url);
      const [token, operation, ...parts] = url.pathname.slice(1).split("/");
      const entry = active;
      if (!entry || token !== entry.token)
        return json(
          { error: "This reader has closed. Reopen the archive." },
          410,
        );
      if (!["GET", "HEAD"].includes(request.method))
        return json({ error: "Read only." }, 405);
      try {
        if (operation === "search")
          return json(
            await entry.engine.search(
              url.searchParams.get("q") || "",
              url.searchParams.get("mode") || "titles",
            ),
          );
        if (operation !== "content")
          return json({ error: "Unknown reader request." }, 404);
        const name = decodeURIComponent(parts.join("/"));
        const result = await entry.engine.entry(name);
        if (!result)
          return json(
            { error: "This page is not included in this archive." },
            404,
          );
        if (result.redirect)
          return new Response(null, {
            status: 302,
            headers: {
              ...headers,
              Location: `obelisk://zim/${token}/content/${result.redirect.split("/").map(encodeURIComponent).join("/")}`,
            },
          });
        const data = result.content;
        let start = 0,
          end = data.length - 1,
          status = 200;
        const range = request.headers.get("range");
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) return new Response(null, { status: 416, headers });
          start = Number(match[1]);
          end = match[2] ? Math.min(end, Number(match[2])) : end;
          if (start > end || start >= data.length)
            return new Response(null, { status: 416, headers });
          status = 206;
        }
        return new Response(
          request.method === "HEAD" ? null : data.subarray(start, end + 1),
          {
            status,
            headers: {
              ...headers,
              "Content-Type": result.mime || "application/octet-stream",
              "Content-Length": String(Math.max(0, end - start + 1)),
              "Accept-Ranges": "bytes",
              ...(status === 206
                ? { "Content-Range": `bytes ${start}-${end}/${data.length}` }
                : {}),
            },
          },
        );
      } catch (error) {
        return json({ error: error.message }, 422);
      }
    },
  };
}
