const CAP = 100;
const STORAGE_KEY = 'block_log_v1';

const log = new Map();
const lastUrl = new Map();

let pendingFlush = null;
let restored = false;
let restoreResolve;
const restorePromise = new Promise(resolve => { restoreResolve = resolve; });

export const whenRestored = () => restorePromise;

export function record(tabId, entry) {
  if (tabId < 0) return null;
  let entries = log.get(tabId);
  if (!entries) {
    entries = [];
    log.set(tabId, entries);
  }
  entries.push(entry);
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
  return scheduleFlush();
}

export function getForTab(tabId) {
  const entries = log.get(tabId);
  if (!entries) return [];
  return entries.map(e => {
    if (!('_consumed' in e)) return e;
    const { _consumed, ...rest } = e;
    return rest;
  });
}

export function clearTab(tabId) {
  const had = log.delete(tabId);
  const hadUrl = lastUrl.delete(tabId);
  if (had || hadUrl) return flushNow();
  return null;
}

export function count(tabId) {
  return log.get(tabId)?.length ?? 0;
}

export function noteNavigation(tabId, url) {
  if (tabId < 0) return { cleared: false, flush: null };
  lastUrl.set(tabId, url);
  const entries = log.get(tabId);
  if (entries) {
    const committedHost = hostOf(url);
    const survivors = committedHost
      ? entries.filter(e => !e._consumed
                         && e.resourceType === 'main_frame'
                         && e.resourceHost === committedHost
                         && e.effect === 'referrer-stripped')
      : [];
    survivors.forEach(e => { e._consumed = true; });
    if (survivors.length) log.set(tabId, survivors);
    else log.delete(tabId);
  }
  return { cleared: true, flush: scheduleFlush() };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

export async function restore(activeTabIds) {
  try {
    await doRestore(activeTabIds);
  } finally {
    restored = true;
    restoreResolve();
  }
}

async function doRestore(activeTabIds) {
  const session = sessionStorage();
  if (!session) return;
  let stored;
  try { stored = await session.get(STORAGE_KEY); }
  catch { return; }
  const data = stored?.[STORAGE_KEY];
  if (!data || typeof data !== 'object') return;
  const validIds = activeTabIds instanceof Set
    ? activeTabIds
    : new Set(activeTabIds ?? []);
  log.clear();
  lastUrl.clear();
  const storedLog = data.log ?? {};
  for (const [key, entries] of Object.entries(storedLog)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (!validIds.has(tabId)) continue;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    log.set(tabId, entries.slice(-CAP));
  }
  const storedLastUrl = data.lastUrl ?? {};
  for (const [key, url] of Object.entries(storedLastUrl)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (!validIds.has(tabId)) continue;
    if (typeof url !== 'string' || !url) continue;
    lastUrl.set(tabId, url);
  }
}

export function flushNow() {
  const session = sessionStorage();
  if (!session) return null;
  const payload = {
    log: Object.fromEntries(log),
    lastUrl: Object.fromEntries(lastUrl),
  };
  return session.set({ [STORAGE_KEY]: payload }).catch(() => {});
}

function scheduleFlush() {
  if (!restored) return null;
  if (!sessionStorage()) return null;
  if (pendingFlush) return pendingFlush;
  pendingFlush = new Promise(resolve => {
    queueMicrotask(() => {
      const promise = flushNow();
      pendingFlush = null;
      Promise.resolve(promise).then(resolve, resolve);
    });
  });
  return pendingFlush;
}

function sessionStorage() {
  return globalThis.browser?.storage?.session ?? null;
}
