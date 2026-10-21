/**
 * What went wrong with a transfer, sorted by what to do about it. The queue acts on
 * the kind; people read the message.
 *
 *   busy     the server asked us to slow down (429, or 503 with Retry-After): wait, then
 *            carry on by ourselves, slowing everything else from that server too
 *   offline  the connection failed or timed out, or the server had a passing fault:
 *            retry a few times, waiting longer each time
 *   refused  the server won't give us this file (401, 403, a web page instead of the
 *            file): stop asking it after a few, rather than keep knocking
 *   gone     the file isn't there any more (404, 410): nothing to retry
 *   changed  the file isn't the one the collection describes (checksum, size, format)
 *   space    the disk is full: everything waits
 */
export class TransferError extends Error {
  constructor(message, kind, { retryAfter = null, host = null } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.host = host;
  }
}
export const transferError = (message, kind, extra) => new TransferError(message, kind, extra);
/** Kinds worth trying again by ourselves. */
export const RETRIED = new Set(["busy", "offline"]);
/** Kinds where trying again later, by hand, is worth it. */
export const RESUMABLE = new Set(["busy", "offline", "refused", "space", undefined, null]);

/** Seconds a Retry-After header asks for, or null. */
export function retryAfter(header, now = Date.now()) {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 1000));
}

/** Sorts an HTTP response that wasn't a success. */
export function fromStatus(status, headers, host) {
  const wait = retryAfter(headers?.get?.("retry-after"));
  const where = host || "The server";
  if (status === 429 || (status === 503 && wait !== null))
    return transferError(`${where} asked Obelisk to slow down.`, "busy", { retryAfter: wait, host });
  if ([500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status))
    return transferError(`${where} had a problem (HTTP ${status}).`, "offline", { host });
  if ([401, 403, 451].includes(status)) return transferError(`${where} refused the download (HTTP ${status}).`, "refused", { host });
  if ([404, 410].includes(status)) return transferError(`The file is no longer at its source (HTTP ${status}).`, "gone", { host });
  return transferError(`${where} returned HTTP ${status}.`, "refused", { host });
}

/** Sorts an error thrown while fetching: a network failure unless it says otherwise. */
export function fromError(error, host) {
  if (error instanceof TransferError || error?.kind) return error;
  const text = `${error?.message || ""} ${error?.cause?.code || ""} ${error?.code || ""}`;
  if (/ENOSPC|disk space/i.test(text)) return transferError(error.message, "space");
  if (/fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|timed? ?out|TimeoutError|terminated|ERR_(?:CONNECTION|NETWORK|INTERNET|NAME|TIMED|ADDRESS|HTTP2|QUIC|SSL)/i.test(text))
    return transferError(`Couldn't reach ${host || "the server"}.`, "offline", { host });
  return error;
}

/**
 * How long to wait before trying again: doubling from `base` seconds, never less than
 * the server asked for, with a little jitter so many waiting downloads don't all return
 * at the same moment.
 */
export function backoff(attempt, base, cap, asked = null) {
  // A server's own figure is the least we wait: one that keeps saying "one second" while
  // still refusing gets longer and longer waits all the same.
  const grown = Math.min(cap, base * 2 ** Math.max(0, attempt - 1)) * (0.85 + Math.random() * 0.3);
  return Math.round(Math.min(cap, Math.max(asked ?? 0, grown, asked === null ? 0 : 1)) * 1000);
}
