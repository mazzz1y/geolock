import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  scanCatalog,
  buildGeoipTagTrie, buildGeositeTagTrie,
} from '../worker/geo/dat-reader.js';
import { parseIp } from '../lib/ip.js';
import { installFakeIndexedDB } from './fixtures/fake-idb.mjs';

const idbData = installFakeIndexedDB();
const geo = await import('../worker/geo/index.js');
const { saveBlob } = await import('../worker/geo/store.js');

const here = dirname(fileURLToPath(import.meta.url));

async function loadGeoipBytes() {
  return new Uint8Array(await readFile(join(here, 'fixtures', 'tiny-geoip.dat')));
}

async function loadGeositeBytes() {
  return new Uint8Array(await readFile(join(here, 'fixtures', 'tiny-geosite.dat')));
}

function sliceFor(bytes, catalog, tag) {
  const slot = catalog.get(tag);
  return bytes.subarray(slot.offset, slot.offset + slot.length);
}

export const tests = [
  {
    name: 'geoip catalog enumerates tags',
    run: async () => {
      const bytes = await loadGeoipBytes();
      const catalog = scanCatalog(bytes);
      assert.deepEqual([...catalog.keys()].sort(), ['cn', 'ru', 'us']);
    },
  },
  {
    name: 'geoip per-tag trie matches ipv4',
    run: async () => {
      const bytes = await loadGeoipBytes();
      const catalog = scanCatalog(bytes);
      const us = buildGeoipTagTrie(sliceFor(bytes, catalog, 'us'));
      const ip = parseIp('8.8.8.42');
      assert.equal(us.trie.contains(ip.family, ip.bytes), true);
      const cn = buildGeoipTagTrie(sliceFor(bytes, catalog, 'cn'));
      assert.equal(cn.trie.contains(ip.family, ip.bytes), false);
    },
  },
  {
    name: 'geoip per-tag trie matches ipv6',
    run: async () => {
      const bytes = await loadGeoipBytes();
      const catalog = scanCatalog(bytes);
      const cn = buildGeoipTagTrie(sliceFor(bytes, catalog, 'cn'));
      const ip = parseIp('2001:db8::1');
      assert.equal(cn.trie.contains(ip.family, ip.bytes), true);
    },
  },
  {
    name: 'geosite catalog enumerates tags',
    run: async () => {
      const bytes = await loadGeositeBytes();
      const catalog = scanCatalog(bytes);
      assert.deepEqual([...catalog.keys()].sort(), ['cn', 'google']);
    },
  },
  {
    name: 'geosite per-tag trie suffix and full',
    run: async () => {
      const bytes = await loadGeositeBytes();
      const catalog = scanCatalog(bytes);
      const google = buildGeositeTagTrie(sliceFor(bytes, catalog, 'google'));
      assert.equal(google.trie.lookup('foo.search.example').size > 0, true);
      assert.equal(google.trie.lookup('mail.search.example').size > 0, true);
      assert.equal(google.trie.lookup('foo.mail.search.example').size > 0, true);
      assert.equal(google.trie.lookup('notsearch.example').size, 0);
    },
  },
  {
    name: 'geosite per-tag trie plain substring',
    run: async () => {
      const bytes = await loadGeositeBytes();
      const catalog = scanCatalog(bytes);
      const cn = buildGeositeTagTrie(sliceFor(bytes, catalog, 'cn'));
      assert.equal(cn.trie.lookup('foo.chat.example').size > 0, true);
    },
  },
  {
    name: 'geosite per-tag trie regex',
    run: async () => {
      const bytes = await loadGeositeBytes();
      const catalog = scanCatalog(bytes);
      const google = buildGeositeTagTrie(sliceFor(bytes, catalog, 'google'));
      assert.equal(google.trie.lookup('cdn.static.example').size > 0, true);
    },
  },
  {
    name: 'geosite per-tag trie attrs',
    run: async () => {
      const bytes = await loadGeositeBytes();
      const catalog = scanCatalog(bytes);
      const google = buildGeositeTagTrie(sliceFor(bytes, catalog, 'google'));
      const mediaHits = google.trie.lookup('media.example');
      let hasAds = false;
      for (const id of mediaHits) {
        if (Array.isArray(google.attrs[id]) && google.attrs[id].includes('ads')) hasAds = true;
      }
      assert.equal(hasAds, true);
      const searchHits = google.trie.lookup('search.example');
      let plainHasAds = false;
      for (const id of searchHits) {
        if (Array.isArray(google.attrs[id]) && google.attrs[id].includes('ads')) plainHasAds = true;
      }
      assert.equal(plainHasAds, false);
    },
  },
  {
    name: 'geo index: inGeoipTag/inGeositeTag return null before any db loaded',
    run: async () => {
      idbData.clear();
      await geo.reloadAll();
      assert.equal(geo.geoipReady(), false);
      assert.equal(geo.geositeReady(), false);
      assert.equal(geo.inGeoipTag(parseIp('8.8.8.42'), 'us'), null);
      assert.equal(geo.inGeositeTag('foo.search.example', 'google'), null);
    },
  },
  {
    name: 'geo index: reload loads db and matchers return booleans',
    run: async () => {
      idbData.clear();
      await saveBlob('geoip.dat', await loadGeoipBytes(), { bodyHash: 'h1' });
      await saveBlob('geosite.dat', await loadGeositeBytes(), { bodyHash: 'h2' });
      const status = await geo.reload('geoip');
      assert.ok(status);
      assert.equal(status.tagCount, 3);
      assert.ok(await geo.reload('geosite'));
      assert.equal(geo.geoipReady(), true);
      assert.equal(geo.geositeReady(), true);
      assert.equal(geo.inGeoipTag(parseIp('8.8.8.42'), 'us'), true);
      assert.equal(geo.inGeoipTag(parseIp('9.9.9.9'), 'us'), false);
      assert.equal(geo.inGeositeTag('foo.search.example', 'google'), true);
      assert.equal(geo.inGeositeTag('other.example', 'google'), false);
    },
  },
  {
    name: 'geo index: failed reload keeps previous index and returns null',
    run: async () => {
      idbData.clear();
      await saveBlob('geoip.dat', await loadGeoipBytes(), { bodyHash: 'h1' });
      assert.ok(await geo.reload('geoip'));
      await saveBlob('geoip.dat', new Uint8Array([0xff, 0xff, 0xff]), { bodyHash: 'broken' });
      const result = await geo.reload('geoip');
      assert.equal(result, null);
      assert.ok(geo.getReloadError('geoip'));
      assert.equal(geo.geoipReady(), true);
      assert.equal(geo.inGeoipTag(parseIp('8.8.8.42'), 'us'), true);
    },
  },
  {
    name: 'geo index: memoized results stay consistent across repeated calls',
    run: async () => {
      idbData.clear();
      await saveBlob('geoip.dat', await loadGeoipBytes(), { bodyHash: 'h1' });
      await saveBlob('geosite.dat', await loadGeositeBytes(), { bodyHash: 'h2' });
      await geo.reloadAll();
      for (let i = 0; i < 3; i += 1) {
        assert.equal(geo.inGeositeTag('foo.search.example', 'google'), true);
        assert.equal(geo.inGeositeTag('other.example', 'google'), false);
        assert.equal(geo.inGeositeTag('media.example', 'google', 'ads'), true);
        assert.equal(geo.inGeositeTag('foo.search.example', 'google', 'ads'), false);
        assert.equal(geo.inGeoipTag(parseIp('8.8.8.42'), 'us'), true);
        assert.equal(geo.inGeoipTag(parseIp('9.9.9.9'), 'us'), false);
      }
    },
  },
  {
    name: 'geo index: memo cache cleared on reload',
    run: async () => {
      idbData.clear();
      await saveBlob('geosite.dat', await loadGeositeBytes(), { bodyHash: 'h2' });
      assert.ok(await geo.reload('geosite'));
      assert.equal(geo.inGeositeTag('foo.search.example', 'google'), true);
      assert.equal(geo.inGeositeTag('foo.chat.example', 'cn'), true);
      idbData.clear();
      assert.ok(await geo.reload('geosite'));
      assert.equal(geo.inGeositeTag('foo.search.example', 'google'), null);
      assert.equal(geo.inGeositeTag('foo.chat.example', 'cn'), null);
    },
  },
  {
    name: 'geo index: reload with no stored blob succeeds as empty',
    run: async () => {
      idbData.clear();
      const status = await geo.reload('geoip');
      assert.ok(status);
      assert.equal(status.tagCount, 0);
      assert.equal(geo.geoipReady(), false);
      assert.equal(geo.getReloadError('geoip'), null);
    },
  },
];
