import {
  scanCatalog,
  buildGeoipTagTrie, buildGeositeTagTrie,
} from './dat-reader.js';
import { parseRuleSet, buildRuleSetMatchers } from './srs-reader.js';
import { loadBlob, deleteBlob } from './store.js';

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

const rulesets = new Map();
let configuredRulesetNames = [];

async function initRuleset(name) {
  const key = `rule-set:${name}`;
  try {
    const { bytes, meta } = await loadBlob(key);
    if (!bytes || !meta?.bodyHash) {
      rulesets.delete(name);
      flushRulesetCache(name);
      return true;
    }
    const rawBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    rulesets.set(name, {
      rawBytes,
      blobMeta: meta,
      rules: null,
      counts: null,
      builtAt: null,
      buildPromise: null,
      lastError: null,
    });
    flushRulesetCache(name);
    return true;
  } catch (error) {
    const message = String(error?.message ?? error);
    const existing = rulesets.get(name);
    if (existing) existing.lastError = message;
    else rulesets.set(name, { rawBytes: null, blobMeta: null, rules: null, counts: null, builtAt: null, buildPromise: null, lastError: message });
    return false;
  }
}

export async function ensureRuleset(name) {
  const entry = rulesets.get(name);
  if (!entry || entry.rules || !entry.rawBytes) return;
  if (entry.buildPromise) return entry.buildPromise;
  entry.buildPromise = (async () => {
    try {
      const parsed = await parseRuleSet(entry.rawBytes);
      const built = buildRuleSetMatchers(parsed);
      entry.rules = built.rules;
      entry.counts = built.counts;
      entry.builtAt = Date.now();
      entry.lastError = null;
      entry.rawBytes = null;
      flushRulesetCache(name);
    } catch (error) {
      entry.lastError = String(error?.message ?? error);
      entry.buildPromise = null;
      throw error;
    }
  })();
  return entry.buildPromise;
}

function flushRulesetCache(name) {
  const prefix = `rs\n${name}\n`;
  for (const key of [...matchCache.keys()]) {
    if (key.startsWith(prefix)) matchCache.delete(key);
  }
}

export async function reloadRuleset(name) {
  const previous = rulesets.get(name) ?? null;
  const ok = await initRuleset(name);
  if (!ok) {
    flushWebRequestCache();
    return null;
  }
  if (rulesets.get(name)?.rawBytes) {
    try { await ensureRuleset(name); }
    catch (error) {
      if (previous) {
        previous.lastError = String(error?.message ?? error);
        rulesets.set(name, previous);
        flushRulesetCache(name);
      }
      flushWebRequestCache();
      return null;
    }
  }
  flushWebRequestCache();
  return rulesetStatus(name);
}

export function inRuleset(name, host, ips) {
  const entry = rulesets.get(name);
  if (!entry?.rules) return null;
  const hostLc = host ? String(host).toLowerCase() : '';
  const ipList = Array.isArray(ips) ? ips.filter(ip => ip?.bytes) : [];
  const key = `rs\n${name}\n${hostLc}\n${ipList.map(ip => `${ip.family}:${ip.bytes.join('.')}`).join(',')}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const result = entry.rules.some(rule => matchRule(rule, hostLc, ipList));
  cacheSet(key, result);
  return result;
}

function matchRule(rule, hostLc, ipList) {
  if (rule.domainTree) {
    if (!hostLc || !rule.domainTree.matchesAny(hostLc)) return false;
  }
  if (rule.ipRadix) {
    if (!ipList.some(ip => rule.ipRadix.contains(ip.family, ip.bytes))) return false;
  }
  return true;
}

export function rulesetLoaded(name) {
  return !!rulesets.get(name)?.rules;
}

function rulesetStatus(name) {
  const entry = rulesets.get(name);
  return {
    name,
    savedAt: entry?.blobMeta?.savedAt ?? null,
    sourceUrl: entry?.blobMeta?.sourceUrl ?? null,
    shaVerified: !!entry?.blobMeta?.shaVerified,
    builtAt: entry?.builtAt ?? null,
    entryCount: entry?.counts
      ? Object.values(entry.counts).reduce((a, b) => a + b, 0)
      : 0,
    error: entry?.lastError ?? null,
  };
}

export function rulesetsStatus() {
  return configuredRulesetNames.map(name => rulesetStatus(name));
}

export async function reload(kind) {
  const store = kind === 'geoip' ? geoip : kind === 'geosite' ? geosite : null;
  if (!store) return null;
  const ok = await store.init();
  markReady();
  flushWebRequestCache();
  return ok ? store.status() : null;
}

export async function reloadAll(rulesetNames = configuredRulesetNames) {
  const previousNames = configuredRulesetNames;
  configuredRulesetNames = Array.isArray(rulesetNames) ? [...rulesetNames] : [];
  for (const name of rulesets.keys()) {
    if (!configuredRulesetNames.includes(name)) {
      rulesets.delete(name);
      flushRulesetCache(name);
    }
  }
  for (const name of previousNames) {
    if (!configuredRulesetNames.includes(name)) {
      deleteBlob(`rule-set:${name}`).catch(() => {});
    }
  }
  await Promise.allSettled([
    geoip.init(),
    geosite.init(),
    ...configuredRulesetNames.map(name => initRuleset(name)),
  ]);
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
  return { geoip: geoip.status(), geosite: geosite.status(), rule_sets: rulesetsStatus() };
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
