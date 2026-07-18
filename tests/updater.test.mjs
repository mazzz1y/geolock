import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFakeIndexedDB } from './fixtures/fake-idb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const idbData = installFakeIndexedDB();

const localStore = new Map();
globalThis.browser = globalThis.browser ?? {};
globalThis.browser.storage = {
  local: {
    get: async key => {
      const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : [];
      const out = {};
      for (const k of keys) if (localStore.has(k)) out[k] = localStore.get(k);
      return out;
    },
    set: async obj => {
      for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
    },
  },
};
globalThis.browser.runtime = { sendMessage: () => Promise.resolve() };

const { isStale, shouldAutoUpdate, parseSha256Sum, fetchWithTimeout, updateRemoteConfig, updateDat } =
  await import('../worker/updater.js');
const { loadConfig, saveConfig, saveRemoteSettings } = await import('../worker/config.js');

const HOUR = 3600 * 1000;

function withFetch(fn, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve(body()).finally(() => { globalThis.fetch = original; });
}

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
  {
    name: 'fetchWithTimeout: timeout covers body download',
    run: async () => {
      const fetchStub = async (_url, init) => ({
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      });
      await withFetch(fetchStub, () => assert.rejects(
        () => fetchWithTimeout('https://slow-body.example/', { timeoutMs: 5, readBody: r => r.arrayBuffer() }),
        err => err?.name === 'AbortError',
      ));
    },
  },
  {
    name: 'fetchWithTimeout: readBody returns body while timer live',
    run: async () => {
      const fetchStub = async () => ({ ok: true, status: 200, text: async () => 'payload' });
      await withFetch(fetchStub, async () => {
        const { response, body } = await fetchWithTimeout('https://x.example/', { readBody: r => r.text() });
        assert.equal(response.ok, true);
        assert.equal(body, 'payload');
      });
    },
  },
  {
    name: 'updateDat: hashes downloaded file only once',
    run: async () => {
      idbData.clear();
      localStore.clear();
      const bytes = new Uint8Array(await readFile(join(here, 'fixtures', 'tiny-geoip.dat')));
      const config = await loadConfig();
      config.data_sources.geoip.url = 'https://dat.example/geoip.dat';
      await saveConfig(config);
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      let digestCalls = 0;
      crypto.subtle.digest = (...args) => { digestCalls += 1; return originalDigest(...args); };
      const fetchStub = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) });
      try {
        await withFetch(fetchStub, () => updateDat('geoip'));
        assert.equal(digestCalls, 1);
        assert.equal(idbData.get('geoip.dat:meta').bodyHash.length, 64);
      } finally {
        crypto.subtle.digest = originalDigest;
      }
    },
  },
  {
    name: 'remote config: data_sources fully replaced by remote',
    run: async () => {
      idbData.clear();
      localStore.clear();
      const config = await loadConfig();
      config.data_sources.geoip = { url: 'https://local.example/geoip.dat', auto_update: false, interval_hours: 6, sha256_url: 'https://local.example/geoip.sha256' };
      config.data_sources.geosite.url = 'https://local.example/geosite.dat';
      await saveConfig(config);
      await saveRemoteSettings({ url: 'https://remote.example/config.json' });
      const remoteJson = JSON.stringify({
        version: 2,
        default_action: 'block',
        dns: {},
        rules: [],
        data_sources: { geoip: { url: 'https://remote.example/geoip.dat' } },
      });
      const fetchStub = async () => ({ ok: true, status: 200, text: async () => remoteJson });
      await withFetch(fetchStub, () => updateRemoteConfig());
      const applied = await loadConfig();
      assert.equal(applied.default_action, 'block');
      assert.equal(applied.data_sources.geoip.url, 'https://remote.example/geoip.dat');
      assert.equal(applied.data_sources.geoip.auto_update, true);
      assert.equal(applied.data_sources.geoip.interval_hours, 24);
      assert.equal(applied.data_sources.geoip.sha256_url, '');
      assert.equal(applied.data_sources.geosite.url, '');
    },
  },
  {
    name: 'updateDat: discards download when source url changed mid-flight',
    run: async () => {
      idbData.clear();
      localStore.clear();
      const bytes = new Uint8Array(await readFile(join(here, 'fixtures', 'tiny-geoip.dat')));
      const config = await loadConfig();
      config.data_sources.geoip.url = 'https://dat.example/original.dat';
      await saveConfig(config);

      const fetchStub = async () => {
        const next = await loadConfig();
        next.data_sources.geoip.url = 'https://dat.example/changed.dat';
        await saveConfig(next);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) };
      };
      const result = await withFetch(fetchStub, () => updateDat('geoip'));
      assert.equal(result.skipped, 'source-changed');
      assert.equal(idbData.has('geoip.dat'), false, 'stale download must not be persisted');
    },
  },
];
