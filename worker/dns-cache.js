import { parseIp } from '../lib/ip.js';

const TIMEOUT = Symbol('timeout');

const DEFAULTS = {
  ttlMs: 300_000,
  negativeTtlMs: 30_000,
  timeoutMs: 5000,
  maxEntries: 512,
};

export function createDnsCache({
  resolver,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  ttlMs = DEFAULTS.ttlMs,
  negativeTtlMs = DEFAULTS.negativeTtlMs,
  timeoutMs = DEFAULTS.timeoutMs,
  maxEntries = DEFAULTS.maxEntries,
} = {}) {
  const entries = new Map();
  const inFlight = new Map();
  const stats = { hits: 0, misses: 0, timeouts: 0 };
  let generation = 0;
  const opts = { ttlMs, negativeTtlMs, timeoutMs, maxEntries };

  function touch(host, entry) {
    entries.delete(host);
    entries.set(host, entry);
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  function lookup(host) {
    if (!host) return Promise.resolve([]);
    const key = host.toLowerCase();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) {
      stats.hits += 1;
      entries.delete(key);
      entries.set(key, cached);
      return Promise.resolve(cached.ips);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    stats.misses += 1;
    const promise = resolveWithTimeout(key)
      .then(({ ips, timedOut }) => {
        if (!timedOut) {
          const ttl = ips.length ? opts.ttlMs : opts.negativeTtlMs;
          if (ttl > 0) touch(key, { ips, expiresAt: now() + ttl });
        }
        return ips;
      })
      .finally(() => { inFlight.delete(key); });

    inFlight.set(key, promise);
    return promise;
  }

  function parseAddresses(result) {
    const addresses = Array.isArray(result?.addresses) ? result.addresses
      : Array.isArray(result) ? result
      : [];
    const parsed = [];
    for (const addr of addresses) {
      const ip = parseIp(addr);
      if (ip) parsed.push(ip);
    }
    return parsed;
  }

  async function resolveWithTimeout(host) {
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimer(() => { stats.timeouts += 1; resolve(TIMEOUT); }, opts.timeoutMs);
    });
    const resolution = Promise.resolve().then(() => resolver(host));
    try {
      const result = await Promise.race([resolution, timeout]);
      if (result === TIMEOUT) {
        const startedGeneration = generation;
        resolution.then(late => {
          if (generation !== startedGeneration) return;
          const ips = parseAddresses(late);
          const ttl = ips.length ? opts.ttlMs : opts.negativeTtlMs;
          if (ttl > 0) touch(host, { ips, expiresAt: now() + ttl });
        }).catch(() => {});
        return { ips: [], timedOut: true };
      }
      return { ips: parseAddresses(result), timedOut: false };
    } catch {
      return { ips: [], timedOut: false };
    } finally {
      if (timer !== null) clearTimer(timer);
    }
  }

  function setOptions(next = {}) {
    if (Number.isFinite(next.ttlMs) && next.ttlMs >= 0) opts.ttlMs = next.ttlMs;
    if (Number.isFinite(next.negativeTtlMs) && next.negativeTtlMs >= 0) opts.negativeTtlMs = next.negativeTtlMs;
    if (Number.isFinite(next.timeoutMs) && next.timeoutMs > 0) opts.timeoutMs = next.timeoutMs;
    if (Number.isFinite(next.maxEntries) && next.maxEntries > 0) opts.maxEntries = next.maxEntries;
  }

  function clearCache() {
    generation += 1;
    entries.clear();
    inFlight.clear();
    stats.hits = 0;
    stats.misses = 0;
    stats.timeouts = 0;
  }

  return { lookup, setOptions, clearCache, _stats: () => ({ ...stats, size: entries.size }) };
}

const defaultCache = createDnsCache({
  resolver: async host => {
    if (typeof browser === 'undefined' || !browser.dns) return { addresses: [] };
    return browser.dns.resolve(host, []);
  },
});

export const lookup = host => defaultCache.lookup(host);
export const setOptions = opts => defaultCache.setOptions(opts);
export const clearCache = () => defaultCache.clearCache();
