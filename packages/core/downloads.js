import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { directSource } from '../sources/direct.js';
import { importFile, safeFilename } from './archive.js';
import { transferHttp } from './http-transfer.js';
import { transferError, fromError, backoff } from './transfer-errors.js';

// Downloads at once in all; single downloads (not from a collection) at once; and from
// any one server, however many collections it's in. Being a polite guest matters more
// than speed: a server that blocks us blocks everyone using Obelisk.
const MAX_ACTIVE = 6, SOLO = 3, PER_HOST = 3, MAX_PARALLEL = 4;
// Servers that ask for less, by their own published guidance.
const HOST_LIMITS = [[/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/, 1], [/(^|\.)archive\.org$/, 2], [/(^|\.)gutenberg\.org$/, 1], [/(^|\.)standardebooks\.org$/, 1]];
// Time between starting two downloads from one server, so a collection never arrives
// as a burst.
const SPACING = 1000;
const hostLimit = host => HOST_LIMITS.find(([pattern]) => pattern.test(host))?.[1] ?? PER_HOST;
// Retried by themselves: how many tries in all, the first wait and the longest (seconds).
const RETRY = { busy: { tries: 8, base: 30, cap: 900 }, offline: { tries: 5, base: 10, cap: 300 } };
// Refusals in a row from one server before the rest of that collection's downloads
// from it stop: past that, asking again only annoys the server.
const REFUSALS = 3;
const LIVE = ['queued', 'downloading', 'verifying', 'pausing', 'waiting'];
// What can't be fixed by trying again: the file has gone, or isn't the one described.
export const FINAL = new Set(['gone', 'changed']);

/** Sources create plans; transfer drivers produce files; one pipeline archives them. */
export function createDownloads({ catalog, root, archiveRoot, onChange, drivers = {}, freeSpace = async () => null, destinationFor = () => undefined, place = async () => ({}), fetch: browserFetch, retry = RETRY, spacing = SPACING }) {
  const active = new Map(), cancelled = new Set(), folder = path.join(root, 'downloads');
  // When each server may be asked again, after it asked us to slow down.
  const cooling = new Map(), refusals = new Map(), started = new Map();
  const transfers = { http: transferHttp, ...drivers };
  let stopping = false, wake = null;
  for (const job of catalog.jobs()) if (LIVE.includes(job.status)) catalog.putJob({ ...job, status: 'paused', retryAt: null, error: 'Obelisk was closed. Resume to continue.' });
  // Partial downloads left behind by transfers that no longer exist (removed, or from a crash).
  void readdir(folder).then(async names => {
    const kept = new Set(catalog.jobs().filter(j => j.status !== 'complete').map(j => j.id));
    for (const name of names) {
      const id = /^([0-9a-f-]{36})\.(part|import)/.exec(name)?.[1];
      if (id && !kept.has(id) && !active.has(id)) await rm(path.join(folder, name), { recursive: true, force: true }).catch(() => {});
    }
  }).catch(() => {});
  const hostOf = job => { try { return new URL(job.url).hostname; } catch { return ''; } };
  const laneOf = job => job.group ? Math.min(MAX_PARALLEL, job.group.parallel || 2) : SOLO;

  /** Starts whatever may start now, and sets a timer for the next thing that's waiting. */
  function pump() {
    if (stopping) return;
    clearTimeout(wake);
    wake = null;
    const now = Date.now(), running = [...active.values()].map(a => a.job);
    let next = Infinity;
    for (const job of catalog.jobs().reverse()) {
      if (active.size >= MAX_ACTIVE) break;
      if (active.has(job.id)) continue;
      if (job.status === 'waiting') {
        if (job.retryAt > now) { next = Math.min(next, job.retryAt); continue; }
      } else if (job.status !== 'queued') continue;
      const host = hostOf(job), until = Math.max(cooling.get(host) || 0, (started.get(host) || 0) + spacing);
      if (until > now) { next = Math.min(next, until); continue; }
      const lane = running.filter(j => (j.group?.id || null) === (job.group?.id || null)).length;
      if (lane >= laneOf(job) || running.filter(j => hostOf(j) === host).length >= hostLimit(host)) continue;
      running.push(job);
      started.set(host, now);
      void run(job);
    }
    if (next < Infinity) wake = setTimeout(pump, Math.max(250, next - now));
  }
  async function run(job) {
    const controller = new AbortController(); active.set(job.id, { controller, job });
    // A cancelled job is gone; late progress reports must not bring it back.
    const save = patch => { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); if (!cancelled.has(job.id)) catalog.putJob(job); };
    save({ status: 'downloading', error: null, retryAt: null });
    const temporaryPath = path.join(folder, `${job.id}.part`);
    try {
      await mkdir(folder, { recursive: true });
      // Known sizes are checked against free space before anything is written.
      await checkSpace(job.total);
      const transfer = transfers[job.driver || 'http'];
      if (!transfer) throw new Error('This transfer type is not available.');
      await transfer({ job, temporaryPath, signal: controller.signal, update: save, checkSpace, ...(job.browser && browserFetch ? { fetch: browserFetch } : {}) });
      if (controller.signal.aborted) throw new Error('Paused');
      save({ status: 'verifying', phase: 'Checking file integrity' });
      // Where it goes is decided now: its folder may have been renamed, moved or deleted since.
      const { directory, warning } = await place(job);
      const result = await importFile({ ...job, directory, catalog, archiveRoot, temporaryPath, id: undefined, source: { ...job.source, finalUrl: job.finalUrl || job.url } });
      save({ status: 'complete', itemId: result.item.id, duplicate: result.duplicate, error: null, failure: null, tries: 0, phase: null, ...(warning ? { warning } : {}) });
      if (job.group) refusals.delete(`${job.group.id}|${hostOf(job)}`);
      try { await onChange(); } catch (error) { save({ warning: `File archived, but HTML export failed: ${error.message}` }); }
    } catch (error) {
      if (controller.signal.aborted) save({ status: 'paused', error: null });
      else settle(job, fromError(error, hostOf(job)), save);
    } finally { active.delete(job.id); pump(); }
  }
  /** What happens after a transfer fails, by the kind of failure. */
  function settle(job, error, save) {
    const kind = error.kind || null, host = error.host || hostOf(job), tries = (job.tries || 0) + 1, rule = retry[kind];
    if (rule && tries < rule.tries) {
      const wait = backoff(tries, rule.base, rule.cap, error.retryAfter);
      // A server that asks us to slow down means everything from it, not just this file.
      if (kind === 'busy') cooling.set(host, Math.max(cooling.get(host) || 0, Date.now() + wait));
      return save({ status: 'waiting', tries, retryAt: Date.now() + wait, failure: kind, error: error.message, phase: null });
    }
    if (kind === 'space') {
      save({ status: 'paused', failure: kind, error: error.message, phase: null });
      return hold(() => true, error.message, 'space');
    }
    save({
      status: 'failed', tries, failure: kind, phase: null,
      error: kind === 'busy' ? `${host} kept asking Obelisk to wait. Resume to try again.`
        : kind === 'offline' ? `${error.message} Check your connection, then resume.` : error.message,
    });
    if (kind === 'refused' && job.group) {
      const key = `${job.group.id}|${host}`, count = (refusals.get(key) || 0) + 1;
      refusals.set(key, count);
      if (count >= REFUSALS) hold(j => j.group?.id === job.group.id && hostOf(j) === host, `${host} is refusing downloads, so the rest from it are paused. Resume to try again later.`, 'refused');
    }
  }
  /** Pauses queued and waiting downloads that match, saying why. */
  function hold(match, message, failure) {
    for (const j of catalog.jobs()) if (['queued', 'waiting'].includes(j.status) && match(j)) catalog.putJob({ ...j, status: 'paused', retryAt: null, error: message, failure });
  }
  const sizeText = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
  /** Refuses a download that would not fit, keeping a little room spare. */
  async function checkSpace(bytes) {
    const free = bytes ? await freeSpace() : null;
    if (free !== null && bytes > free - 512 * 1024 ** 2)
      throw transferError(`Not enough disk space. This needs ${sizeText(bytes)}; ${sizeText(Math.max(0, free))} is free.`, 'space');
  }
  // A collection's entry is the same entry whichever job or item holds it.
  const sameEntry = (a, b) => a?.collection && b?.collection && a.collection.id === b.collection.id && a.collection.key === b.collection.key;
  function queue(plan) {
    if (stopping) throw new Error('The manager is shutting down.');
    if (catalog.jobs().filter(j => j.status === 'queued').length >= 1000) throw new Error('The queue is full. Wait for some jobs to finish.');
    directSource.resolve({ url: plan.url });
    const matches = source => (plan.source?.seriesKey && source?.seriesKey === plan.source.seriesKey && source?.version === plan.source.version) || sameEntry(plan.source, source);
    const existingItem = catalog.list().find(i => !i.placeholder && matches(i.source));
    if (existingItem) return { status: 'complete', duplicate: true, itemId: existingItem.id, title: existingItem.title };
    const existingJob = catalog.jobs().find(j => matches(j.source) && j.status !== 'complete');
    if (existingJob) {
      // Asking again for one that stopped picks it up where it left off.
      if (['paused', 'failed'].includes(existingJob.status) && !FINAL.has(existingJob.failure)) {
        const again = { ...existingJob, status: 'queued', error: null, failure: null, tries: 0, retryAt: null };
        catalog.putJob(again);
        return again;
      }
      return existingJob;
    }
    const folderId = plan.folderId || destinationFor(plan);
    const job = { ...plan, ...(folderId ? { folderId } : {}), filename: safeFilename(plan.filename), id: randomUUID(), status: 'queued', bytes: 0, total: plan.expectedBytes || plan.estimatedBytes || null, createdAt: new Date().toISOString() };
    catalog.putJob(job);
    return job;
  }
  const addPlan = plan => { const job = queue(plan); pump(); return job; };
  const resumable = j => ['paused', 'failed'].includes(j.status) && !FINAL.has(j.failure);
  function resume(id) {
    const job = catalog.job(id);
    if (!job || !['paused', 'failed', 'waiting'].includes(job.status)) throw new Error('This download cannot be resumed.');
    if (active.has(id)) throw new Error('Wait for the previous transfer to stop.');
    catalog.putJob({ ...job, status: 'queued', error: null, failure: null, tries: 0, retryAt: null });
    if (job.group) refusals.delete(`${job.group.id}|${hostOf(job)}`);
    pump();
  }
  /** Stops a transfer if it is running, deletes what it downloaded so far, and removes it from the list. */
  async function cancel(id) {
    if (!catalog.job(id)) return;
    cancelled.add(id);
    try {
      active.get(id)?.controller.abort();
      while (active.has(id)) await new Promise(r => setTimeout(r, 20));
      catalog.removeJob(id);
      for (const leftover of [`${id}.part`, `${id}.part.video`, `${id}.part.warc.gz`])
        await rm(path.join(folder, leftover), { recursive: true, force: true });
    } finally { cancelled.delete(id); }
  }
  return {
    add: input => addPlan(directSource.resolve(input)), addPlan,
    /** Queues many plans at once (a collection), starting them in order. */
    addPlans(plans) {
      const jobs = [];
      try { for (const plan of plans) jobs.push(queue(plan)); } finally { pump(); }
      return jobs;
    },
    checkSpace,
    pause(id) {
      const job = catalog.job(id);
      if (!job || !['queued', 'downloading', 'waiting'].includes(job.status)) throw new Error('Only queued or active transfers can be paused.');
      catalog.putJob({ ...job, status: job.status === 'downloading' ? 'pausing' : 'paused', retryAt: null }); active.get(id)?.controller.abort();
    },
    resume,
    async cancel(id) { await cancel(id); pump(); },
    /** Acts on every download of one collection together. */
    async group(id, action) {
      const jobs = catalog.jobs().filter(j => j.group?.id === id);
      if (action === 'pause') {
        for (const j of jobs)
          if (['queued', 'waiting'].includes(j.status)) catalog.putJob({ ...j, status: 'paused', retryAt: null, error: null });
          else if (j.status === 'downloading') { catalog.putJob({ ...j, status: 'pausing' }); active.get(j.id)?.controller.abort(); }
      } else if (action === 'resume') {
        for (const key of [...refusals.keys()]) if (key.startsWith(`${id}|`)) refusals.delete(key);
        for (const j of jobs) if (resumable(j) && !active.has(j.id)) catalog.putJob({ ...j, status: 'queued', error: null, failure: null, tries: 0, retryAt: null });
      } else if (action === 'cancel') {
        for (const j of jobs) if (j.status !== 'complete') await cancel(j.id);
      } else if (action === 'clear') {
        for (const j of jobs) if (j.status === 'complete' || (j.status === 'failed' && FINAL.has(j.failure))) catalog.removeJob(j.id);
      } else throw new Error('Unknown action.');
      pump();
    },
    /** Removes finished transfers from the list. Their files stay in the library. */
    clearFinished() { for (const job of catalog.jobs()) if (job.status === 'complete') catalog.removeJob(job.id); },
    async stop() {
      stopping = true;
      clearTimeout(wake);
      for (const { controller } of active.values()) controller.abort();
      while (active.size) await new Promise(r => setTimeout(r, 20));
    },
  };
}
