import assert from 'node:assert/strict';
import { isStale, shouldAutoUpdate, parseSha256Sum, mergeDataSources, fetchWithTimeout } from '../worker/updater.js';

const HOUR = 3600 * 1000;

export const tests = [
  {
    name: 'isStale: missing lastCheckedAt is stale',
    run: () => {
      assert.equal(isStale({ lastCheckedAt: null, intervalHours: 24 }), true);
      assert.equal(isStale({ lastCheckedAt: 0, intervalHours: 24 }), true);
      assert.equal(isStale({ lastCheckedAt: undefined, intervalHours: 24 }), true);
    },
  },
  {
    name: 'isStale: invalid interval is stale',
    run: () => {
      assert.equal(isStale({ lastCheckedAt: Date.now(), intervalHours: 0 }), true);
      assert.equal(isStale({ lastCheckedAt: Date.now(), intervalHours: -1 }), true);
      assert.equal(isStale({ lastCheckedAt: Date.now(), intervalHours: NaN }), true);
    },
  },
  {
    name: 'isStale: within interval is fresh',
    run: () => {
      const now = 10 * HOUR;
      assert.equal(isStale({ lastCheckedAt: now - HOUR, intervalHours: 24, now }), false);
    },
  },
  {
    name: 'isStale: exactly at interval boundary is stale',
    run: () => {
      const now = 100 * HOUR;
      assert.equal(isStale({ lastCheckedAt: now - 24 * HOUR, intervalHours: 24, now }), true);
    },
  },
  {
    name: 'shouldAutoUpdate: empty url is false',
    run: () => {
      assert.equal(shouldAutoUpdate({ url: '', auto_update: true }), false);
      assert.equal(shouldAutoUpdate(null), false);
      assert.equal(shouldAutoUpdate(undefined), false);
    },
  },
  {
    name: 'shouldAutoUpdate: defaults auto_update to true when missing',
    run: () => {
      assert.equal(shouldAutoUpdate({ url: 'https://x' }), true);
    },
  },
  {
    name: 'parseSha256Sum: plain hex',
    run: () => {
      const hex = 'a'.repeat(64);
      assert.equal(parseSha256Sum(hex), hex);
    },
  },
  {
    name: 'parseSha256Sum: hex with filename',
    run: () => {
      const hex = 'b'.repeat(64);
      assert.equal(parseSha256Sum(`${hex}  geoip.dat`), hex);
    },
  },
  {
    name: 'parseSha256Sum: no hash returns null',
    run: () => {
      assert.equal(parseSha256Sum('not a hash here'), null);
      assert.equal(parseSha256Sum(''), null);
    },
  },
  {
    name: 'parseSha256Sum: mixed case lowercased',
    run: () => {
      const hex = 'AaBbCcDd' + '0'.repeat(56);
      assert.equal(parseSha256Sum(hex), hex.toLowerCase());
    },
  },
  {
    name: 'parseSha256Sum: wrong-length hex skipped',
    run: () => {
      const short = 'a'.repeat(63);
      assert.equal(parseSha256Sum(short), null);
    },
  },
  {
    name: 'mergeDataSources: incoming overrides current',
    run: () => {
      const current = { geoip: { url: 'a', interval_hours: 24 }, geosite: { url: 'b' } };
      const incoming = { geoip: { url: 'a2' }, geosite: { url: 'b2' } };
      const merged = mergeDataSources(current, incoming);
      assert.equal(merged.geoip.url, 'a2');
      assert.equal(merged.geoip.interval_hours, 24);
      assert.equal(merged.geosite.url, 'b2');
    },
  },
  {
    name: 'mergeDataSources: missing kind in incoming keeps current',
    run: () => {
      const current = { geoip: { url: 'a' }, geosite: { url: 'b' } };
      const merged = mergeDataSources(current, { geoip: { url: 'a2' } });
      assert.equal(merged.geoip.url, 'a2');
      assert.equal(merged.geosite.url, 'b');
    },
  },
  {
    name: 'fetchWithTimeout: aborts when fetch never resolves',
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      try {
        await assert.rejects(
          () => fetchWithTimeout('https://hangs.example/', { timeoutMs: 5 }),
          err => err?.name === 'AbortError',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: 'fetchWithTimeout: returns response when fetch resolves quickly',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const stubResponse = { ok: true, status: 200 };
      globalThis.fetch = async () => stubResponse;
      try {
        const response = await fetchWithTimeout('https://fast.example/');
        assert.equal(response, stubResponse);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];
