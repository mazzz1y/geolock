import {
  scanCatalog,
  buildGeoipTagTrie, buildGeositeTagTrie,
} from './dat-reader.js';
import { loadBlobBody, loadBlobMeta } from './store.js';

const geoip = createStore({ name: 'geoip', buildTagTrie: buildGeoipTagTrie });
const geosite = createStore({ name: 'geosite', buildTagTrie: buildGeositeTagTrie });

let readyResolve;
let readyPromise = new Promise(resolve => { readyResolve = resolve; });

export const whenReady = () => readyPromise;

function createStore({ name, buildTagTrie }) {
  const state = {
    rawBytes: null,
    blobMeta: null,
    catalog: null,
    entries: new Map(),
    totalCount: 0,
    builtAt: null,
    error: null,
  };

  function reset() {
    state.rawBytes = null;
    state.blobMeta = null;
    state.catalog = null;
    state.entries = new Map();
    state.totalCount = 0;
    state.builtAt = null;
    state.error = null;
  }

  async function init() {
    reset();
    const key = `${name}.dat`;
    const blobMeta = await loadBlobMeta(key);
    const rawBytes = await loadBlobBody(key);
    if (!rawBytes || !blobMeta?.bodyHash) return;
    state.rawBytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
    state.blobMeta = blobMeta;
    try {
      state.catalog = scanCatalog(state.rawBytes);
    } catch (error) {
      state.error = String(error?.message ?? error);
      state.catalog = null;
      return;
    }
    state.totalCount = sumCounts(state.catalog);
    state.builtAt = Date.now();
  }

  function query(tag, ...args) {
    if (!state.catalog) return null;
    const tagLc = String(tag).toLowerCase();
    let entry = state.entries.get(tagLc);
    if (!entry) {
      const slot = state.catalog.get(tagLc);
      if (!slot) return null;
      const slice = state.rawBytes.subarray(slot.offset, slot.offset + slot.length);
      const built = buildTagTrie(slice);
      entry = { trie: built.trie, attrs: built.attrs ?? null };
      state.entries.set(tagLc, entry);
    }
    return entry;
  }

  function status() {
    return {
      kind: name,
      savedAt: state.blobMeta?.savedAt ?? null,
      sourceUrl: state.blobMeta?.sourceUrl ?? null,
      shaVerified: !!state.blobMeta?.shaVerified,
      builtAt: state.builtAt,
      tagCount: state.catalog?.size ?? 0,
      entryCount: state.totalCount,
    };
  }

  function getError() {
    return state.error;
  }

  return { init, query, status, getError };
}

function sumCounts(catalog) {
  let total = 0;
  for (const slot of catalog.values()) total += slot.count;
  return total;
}

export async function reload(kind) {
  const store = kind === 'geoip' ? geoip : kind === 'geosite' ? geosite : null;
  if (!store) return null;
  await store.init();
  flushWebRequestCache();
  return store.status();
}

export async function reloadAll() {
  await Promise.allSettled([geoip.init(), geosite.init()]);
  readyResolve();
  flushWebRequestCache();
}

export function inGeoipTag(ip, tag) {
  if (!ip?.bytes) return false;
  const entry = geoip.query(tag);
  if (!entry) return false;
  return entry.trie.contains(ip.family, ip.bytes);
}

export function inGeositeTag(host, tag, attr = null) {
  if (!host) return false;
  const entry = geosite.query(tag, host);
  if (!entry) return false;
  const hits = entry.trie.lookup(host);
  if (hits.size === 0) return false;
  if (!attr) return true;
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
