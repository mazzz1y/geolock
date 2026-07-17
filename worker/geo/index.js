import {
  scanCatalog,
  buildGeoipTagTrie, buildGeositeTagTrie,
} from './dat-reader.js';
import { loadBlob } from './store.js';

const MATCH_CACHE_MAX = 4096;
const matchCache = new Map();

function cacheGet(key) {
  if (!matchCache.has(key)) return undefined;
  const value = matchCache.get(key);
  matchCache.delete(key);
  matchCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  matchCache.delete(key);
  matchCache.set(key, value);
  while (matchCache.size > MATCH_CACHE_MAX) {
    const oldest = matchCache.keys().next().value;
    matchCache.delete(oldest);
  }
}

const geoip = createStore({ name: 'geoip', buildTagTrie: buildGeoipTagTrie });
const geosite = createStore({ name: 'geosite', buildTagTrie: buildGeositeTagTrie });

let readyResolve;
let readyPromise = new Promise(resolve => { readyResolve = resolve; });
let readyResolved = false;

function markReady() {
  if (readyResolved) return;
  readyResolved = true;
  readyResolve();
}

export const whenReady = () => readyPromise;
export const forceReady = () => markReady();

function createStore({ name, buildTagTrie }) {
  let current = null;
  let lastError = null;

  async function init() {
    const key = `${name}.dat`;
    try {
      const { bytes, meta } = await loadBlob(key);
      if (!bytes || !meta?.bodyHash) {
        current = null;
        lastError = null;
        matchCache.clear();
        return true;
      }
      const rawBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const catalog = scanCatalog(rawBytes);
      current = {
        rawBytes,
        blobMeta: meta,
        catalog,
        entries: new Map(),
        totalCount: sumCounts(catalog),
        builtAt: Date.now(),
      };
      lastError = null;
      matchCache.clear();
      return true;
    } catch (error) {
      lastError = String(error?.message ?? error);
      return false;
    }
  }

  function isLoaded() {
    return current !== null;
  }

  function query(tag) {
    if (!current) return null;
    const tagLc = String(tag).toLowerCase();
    let entry = current.entries.get(tagLc);
    if (!entry) {
      const slot = current.catalog.get(tagLc);
      if (!slot) return null;
      const slice = current.rawBytes.subarray(slot.offset, slot.offset + slot.length);
      const built = buildTagTrie(slice);
      entry = { trie: built.trie, attrs: built.attrs ?? null };
      current.entries.set(tagLc, entry);
    }
    return entry;
  }

  function status() {
    return {
      kind: name,
      savedAt: current?.blobMeta?.savedAt ?? null,
      sourceUrl: current?.blobMeta?.sourceUrl ?? null,
      shaVerified: !!current?.blobMeta?.shaVerified,
      builtAt: current?.builtAt ?? null,
      tagCount: current?.catalog?.size ?? 0,
      entryCount: current?.totalCount ?? 0,
    };
  }

  function getError() {
    return lastError;
  }

  return { init, query, status, getError, isLoaded };
}

function sumCounts(catalog) {
  let total = 0;
  for (const slot of catalog.values()) total += slot.count;
  return total;
}

export async function reload(kind) {
  const store = kind === 'geoip' ? geoip : kind === 'geosite' ? geosite : null;
  if (!store) return null;
  const ok = await store.init();
  markReady();
  flushWebRequestCache();
  return ok ? store.status() : null;
}

export async function reloadAll() {
  await Promise.allSettled([geoip.init(), geosite.init()]);
  markReady();
  flushWebRequestCache();
}

export function geoipReady() {
  return geoip.isLoaded();
}

export function geositeReady() {
  return geosite.isLoaded();
}

export function inGeoipTag(ip, tag) {
  if (!geoip.isLoaded()) return null;
  if (!ip?.bytes) return false;
  const key = `ip\n${tag}\n${ip.family}\n${ip.bytes.join('.')}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const entry = geoip.query(tag);
  const result = entry ? entry.trie.contains(ip.family, ip.bytes) : false;
  cacheSet(key, result);
  return result;
}

export function inGeositeTag(host, tag, attr = null) {
  if (!geosite.isLoaded()) return null;
  if (!host) return false;
  const key = `site\n${tag}\n${attr ?? ''}\n${host.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const result = computeGeositeMatch(host, tag, attr);
  cacheSet(key, result);
  return result;
}

function computeGeositeMatch(host, tag, attr) {
  const entry = geosite.query(tag, host);
  if (!entry) return false;
  if (!attr) return entry.trie.matchesAny(host);
  const hits = entry.trie.lookup(host);
  if (hits.size === 0) return false;
  const attrs = entry.attrs;
  if (!Array.isArray(attrs)) return false;
  const attrLc = String(attr).toLowerCase();
  for (const entryId of hits) {
    const list = attrs[entryId];
    if (Array.isArray(list) && list.includes(attrLc)) return true;
  }
  return false;
}

export function status() {
  return { geoip: geoip.status(), geosite: geosite.status() };
}

export function getReloadError(kind) {
  if (kind === 'geoip') return geoip.getError();
  if (kind === 'geosite') return geosite.getError();
  return null;
}

export function flushWebRequestCache() {
  try { browser.webRequest.handlerBehaviorChanged(); }
  catch { /* ... */ }
}
