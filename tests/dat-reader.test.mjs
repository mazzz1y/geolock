import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  scanCatalog,
  buildGeoipTagTrie, buildGeositeTagTrie,
} from '../worker/geo/dat-reader.js';
import { parseIp } from '../lib/ip.js';

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
];
