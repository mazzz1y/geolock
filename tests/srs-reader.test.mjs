import { strict as assert } from 'node:assert';
import { installFakeIndexedDB } from './fixtures/fake-idb.mjs';
import {
  ByteWriter, buildSrs, buildSuccinctSet, domainSetKeys,
  writeDomainSetItem, writeStringListItem, writeIpSetItem,
} from './fixtures/srs-writer.mjs';

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

const { parseRuleSet, buildRuleSetMatchers } = await import('../worker/geo/srs-reader.js');
const geo = await import('../worker/geo/index.js');
const { saveBlob } = await import('../worker/geo/store.js');
const updater = await import('../worker/updater.js');
const { loadConfig, saveConfig, validateConfig, mergeWithDefaults } = await import('../worker/config.js');
const { matches, UNDECIDED } = await import('../worker/matchers.js');
const { parseIp } = await import('../lib/ip.js');

function v4(text) {
  return parseIp(text).bytes;
}

function withFetch(fn, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve(body()).finally(() => { globalThis.fetch = original; });
}

function jsonBytes(doc) {
  return new TextEncoder().encode(JSON.stringify(doc));
}

function cidrStrings(cidrs) {
  return cidrs.map(c => `${[...c.bytes].join('.')}/${c.prefix}`).sort();
}

export const tests = [
  {
    name: 'srs: rejects bad magic',
    run: async () => {
      await assert.rejects(() => parseRuleSet(new Uint8Array([0x53, 0x52, 0x58, 1, 0])), /not a valid/);
    },
  },
  {
    name: 'srs: rejects unsupported version',
    run: async () => {
      await assert.rejects(() => parseRuleSet(buildSrs({ version: 0, rules: [] })), /version 0/);
      await assert.rejects(() => parseRuleSet(buildSrs({ version: 6, rules: [] })), /version 6/);
      for (const version of [1, 2, 3, 4, 5]) {
        const parsed = await parseRuleSet(buildSrs({ version, rules: [] }));
        assert.deepEqual(parsed.domains, []);
      }
    },
  },
  {
    name: 'srs: rejects truncated / corrupt zlib payload',
    run: async () => {
      const good = buildSrs({ rules: [] });
      const bad = good.slice(0, good.length - 3);
      await assert.rejects(() => parseRuleSet(bad));
    },
  },
  {
    name: 'srs: decodes keywords, regexes and ip ranges',
    run: async () => {
      const bytes = buildSrs({
        rules: [{
          write: w => {
            writeStringListItem(w, 3, ['tracker', 'ads']);
            writeStringListItem(w, 4, ['^cdn\\d+\\.', '[']);
            writeIpSetItem(w, 6, [
              { from: v4('10.0.0.0'), to: v4('10.0.0.255') },
              { from: v4('192.168.1.3'), to: v4('192.168.1.9') },
            ]);
          },
        }],
      });
      const parsed = await parseRuleSet(bytes);
      assert.deepEqual(parsed.keywords, ['tracker', 'ads']);
      assert.deepEqual(parsed.regexes, ['^cdn\\d+\\.', '[']);
      assert.deepEqual(cidrStrings(parsed.cidrs), [
        '10.0.0.0/24',
        '192.168.1.3/32',
        '192.168.1.4/30',
        '192.168.1.8/31',
      ].sort());
    },
  },
  {
    name: 'srs: v6 range spanning multiple CIDRs',
    run: async () => {
      const from = parseIp('2001:db8::1').bytes;
      const to = parseIp('2001:db8::4').bytes;
      const bytes = buildSrs({
        rules: [{ write: w => writeIpSetItem(w, 6, [{ from, to }]) }],
      });
      const parsed = await parseRuleSet(bytes);
      assert.equal(parsed.cidrs.length, 3);
      assert.deepEqual(parsed.cidrs.map(c => c.prefix).sort((a, b) => a - b), [127, 128, 128]);
      const { ipRadix } = buildRuleSetMatchers(parsed);
      assert.equal(ipRadix.contains(6, parseIp('2001:db8::1').bytes), true);
      assert.equal(ipRadix.contains(6, parseIp('2001:db8::4').bytes), true);
      assert.equal(ipRadix.contains(6, parseIp('2001:db8::').bytes), false);
      assert.equal(ipRadix.contains(6, parseIp('2001:db8::5').bytes), false);
    },
  },
  {
    name: 'srs: succinct set round-trip with exact domains and v2 suffixes',
    run: async () => {
      const bytes = buildSrs({
        rules: [{
          write: w => writeDomainSetItem(w, {
            domains: ['exact.example.org'],
            suffixes: ['example.com'],
            strictSuffixes: ['strict.net'],
          }),
        }],
      });
      const parsed = await parseRuleSet(bytes);
      assert.deepEqual(parsed.domains.sort(), ['exact.example.org']);
      assert.deepEqual(parsed.suffixes.sort(), ['example.com']);
      assert.deepEqual(parsed.strictSuffixes.sort(), ['strict.net']);
      const { domainTree } = buildRuleSetMatchers(parsed);
      assert.equal(domainTree.matchesAny('exact.example.org'), true);
      assert.equal(domainTree.matchesAny('sub.exact.example.org'), false);
      assert.equal(domainTree.matchesAny('example.com'), true);
      assert.equal(domainTree.matchesAny('a.example.com'), true);
      assert.equal(domainTree.matchesAny('strict.net'), false);
      assert.equal(domainTree.matchesAny('a.strict.net'), true);
    },
  },
  {
    name: 'srs: succinct set v1 legacy \\r encoding',
    run: async () => {
      const bytes = buildSrs({
        version: 1,
        rules: [{
          write: w => writeDomainSetItem(w, {
            suffixes: ['legacy.example'],
            strictSuffixes: ['only-subs.example'],
            legacy: true,
          }),
        }],
      });
      const parsed = await parseRuleSet(bytes);
      assert.deepEqual(parsed.suffixes.sort(), ['legacy.example']);
      assert.deepEqual(parsed.strictSuffixes.sort(), ['only-subs.example']);
      assert.deepEqual(parsed.domains, []);
      const { domainTree } = buildRuleSetMatchers(parsed);
      assert.equal(domainTree.matchesAny('legacy.example'), true);
      assert.equal(domainTree.matchesAny('a.legacy.example'), true);
      assert.equal(domainTree.matchesAny('only-subs.example'), false);
      assert.equal(domainTree.matchesAny('a.only-subs.example'), true);
    },
  },
  {
    name: 'srs: succinct writer matches hand-computed tiny trie',
    run: () => {
      const set = buildSuccinctSet(['ab', 'ac']);
      assert.deepEqual([...set.labels].map(c => String.fromCharCode(c)), ['a', 'b', 'c']);
      assert.equal(set.labelBitmap[0], 0b1110010n);
      assert.equal(set.leaves[0], (1n << 2n) | (1n << 3n));
      const keys = domainSetKeys({ suffixes: ['x.y'] });
      assert.deepEqual(keys, ['y.x\n']);
    },
  },
  {
    name: 'srs: multiple default rules are unioned',
    run: async () => {
      const bytes = buildSrs({
        rules: [
          { write: w => writeStringListItem(w, 3, ['one']) },
          { write: w => writeStringListItem(w, 3, ['two']) },
        ],
      });
      const parsed = await parseRuleSet(bytes);
      assert.deepEqual(parsed.keywords.sort(), ['one', 'two']);
    },
  },
  {
    name: 'srs: skips irrelevant item types',
    run: async () => {
      const bytes = buildSrs({
        rules: [{
          write: w => {
            w.byte(0);
            w.uvarint(2);
            w.bytes([0, 1, 0, 28]);
            writeStringListItem(w, 1, ['tcp']);
            w.byte(9);
            w.uvarint(1);
            w.bytes([0x01, 0xbb]);
            w.byte(19);
            w.byte(1);
            w.byte(18);
            w.uvarint(2);
            w.bytes([0, 1]);
            writeIpSetItem(w, 5, [{ from: v4('1.2.3.4'), to: v4('1.2.3.4') }]);
            writeStringListItem(w, 3, ['kept']);
          },
        }],
      });
      const parsed = await parseRuleSet(bytes);
      assert.deepEqual(parsed.keywords, ['kept']);
      assert.deepEqual(parsed.cidrs, []);
    },
  },
  {
    name: 'srs: rejects logical rules, invert, adguard, unknown items',
    run: async () => {
      await assert.rejects(
        () => parseRuleSet(buildSrs({ rules: [{ logical: true }] })),
        /logical/,
      );
      await assert.rejects(
        () => parseRuleSet(buildSrs({ rules: [{ invert: true, write: () => {} }] })),
        /inverted/,
      );
      await assert.rejects(
        () => parseRuleSet(buildSrs({ rules: [{ write: w => w.byte(16) }] })),
        /adguard/,
      );
      await assert.rejects(
        () => parseRuleSet(buildSrs({ rules: [{ write: w => w.byte(200) }] })),
        /unsupported rule item 200/,
      );
    },
  },
  {
    name: 'srs: JSON source format',
    run: async () => {
      const parsed = await parseRuleSet(jsonBytes({
        version: 3,
        rules: [
          {
            domain: 'One.Example',
            domain_suffix: ['example.com', '.strict.example'],
            domain_keyword: 'kw',
            domain_regex: ['^a', '^b'],
            ip_cidr: ['10.0.0.0/8', '1.2.3.4'],
          },
        ],
      }));
      assert.deepEqual(parsed.domains, ['one.example']);
      assert.deepEqual(parsed.suffixes, ['example.com']);
      assert.deepEqual(parsed.strictSuffixes, ['strict.example']);
      assert.deepEqual(parsed.keywords, ['kw']);
      assert.deepEqual(parsed.regexes, ['^a', '^b']);
      assert.equal(parsed.cidrs.length, 2);
      assert.equal(parsed.cidrs[1].prefix, 32);
    },
  },
  {
    name: 'srs: JSON source rejects logical/invert/bad cidr',
    run: async () => {
      await assert.rejects(() => parseRuleSet(jsonBytes({ rules: [{ type: 'logical', rules: [] }] })), /logical/);
      await assert.rejects(() => parseRuleSet(jsonBytes({ rules: [{ domain: 'x', invert: true }] })), /inverted/);
      await assert.rejects(() => parseRuleSet(jsonBytes({ rules: [{ ip_cidr: 'not-an-ip' }] })), /invalid ip_cidr/);
      await assert.rejects(() => parseRuleSet(jsonBytes({ rules: {} })), /rules array/);
      await assert.rejects(() => parseRuleSet(new TextEncoder().encode('garbage')), /not a valid/);
    },
  },
  {
    name: 'geo: inRuleset tri-state and reload',
    run: async () => {
      idbData.clear();
      await geo.reloadAll(['ads']);
      assert.equal(geo.inRuleset('ads', 'example.com', []), null);

      const bytes = buildSrs({
        rules: [{
          write: w => {
            writeDomainSetItem(w, { suffixes: ['blocked.example'] });
            writeIpSetItem(w, 6, [{ from: v4('9.9.9.9'), to: v4('9.9.9.9') }]);
          },
        }],
      });
      await saveBlob('ruleset:ads', bytes, { bodyHash: 'x'.repeat(64), sourceUrl: 'https://x/', shaVerified: false });
      assert.ok(await geo.reloadRuleset('ads'));

      assert.equal(geo.inRuleset('ads', 'a.blocked.example', []), true);
      assert.equal(geo.inRuleset('ads', 'other.example', []), false);
      assert.equal(geo.inRuleset('ads', 'other.example', [parseIp('9.9.9.9')]), true);
      assert.equal(geo.inRuleset('ads', '', [parseIp('9.9.9.9')]), true);
      assert.equal(geo.inRuleset('ads', '', [parseIp('8.8.8.8')]), false);
      assert.equal(geo.inRuleset('missing', 'x', []), null);

      const cached = geo.inRuleset('ads', 'a.blocked.example', []);
      assert.equal(cached, true);

      const bytes2 = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['different.example'] }) }],
      });
      await saveBlob('ruleset:ads', bytes2, { bodyHash: 'y'.repeat(64), sourceUrl: 'https://x/', shaVerified: false });
      await geo.reloadRuleset('ads');
      assert.equal(geo.inRuleset('ads', 'a.blocked.example', []), false);
      assert.equal(geo.inRuleset('ads', 'a.different.example', []), true);

      const status = geo.status();
      assert.ok(Array.isArray(status.rulesets));
      assert.equal(status.rulesets[0].name, 'ads');
      assert.ok(status.rulesets[0].entryCount > 0);
    },
  },
  {
    name: 'geo: reload keeps previous data and reports error on bad blob',
    run: async () => {
      idbData.clear();
      const bytes = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['ok.example'] }) }],
      });
      await saveBlob('ruleset:r1', bytes, { bodyHash: 'a'.repeat(64) });
      await geo.reloadAll(['r1']);
      assert.equal(geo.inRuleset('r1', 'x.ok.example', []), null);
      await geo.ensureRuleset('r1');
      assert.equal(geo.inRuleset('r1', 'x.ok.example', []), true);

      await saveBlob('ruleset:r1', new TextEncoder().encode('garbage'), { bodyHash: 'b'.repeat(64) });
      assert.equal(await geo.reloadRuleset('r1'), null);
      assert.equal(geo.inRuleset('r1', 'x.ok.example', []), true);
      assert.match(geo.rulesetsStatus().find(r => r.name === 'r1').error, /not a valid/);
    },
  },
  {
    name: 'geo: reloadAll defers decode until ensureRuleset',
    run: async () => {
      idbData.clear();
      const bytes = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['lazy.example'] }) }],
      });
      await saveBlob('ruleset:lazy', bytes, { bodyHash: 'c'.repeat(64), savedAt: 111 });
      await geo.reloadAll(['lazy']);

      assert.equal(geo.inRuleset('lazy', 'a.lazy.example', []), null);
      assert.equal(geo.rulesetLoaded('lazy'), false);
      let status = geo.status().rulesets.find(r => r.name === 'lazy');
      assert.equal(status.builtAt, null);
      assert.equal(status.entryCount, 0);
      assert.equal(status.savedAt, 111);

      await geo.ensureRuleset('lazy');
      assert.equal(geo.inRuleset('lazy', 'a.lazy.example', []), true);
      assert.equal(geo.rulesetLoaded('lazy'), true);
      status = geo.status().rulesets.find(r => r.name === 'lazy');
      assert.ok(status.builtAt);
      assert.ok(status.entryCount > 0);

      await geo.ensureRuleset('lazy');
      await geo.ensureRuleset('unknown');
    },
  },
  {
    name: 'geo: concurrent ensureRuleset dedupes decode work',
    run: async () => {
      idbData.clear();
      const bytes = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['dedupe.example'] }) }],
      });
      await saveBlob('ruleset:dd', bytes, { bodyHash: 'd'.repeat(64) });
      await geo.reloadAll(['dd']);

      const OriginalDS = globalThis.DecompressionStream;
      let inflateCalls = 0;
      globalThis.DecompressionStream = class extends OriginalDS {
        constructor(format) {
          inflateCalls += 1;
          super(format);
        }
      };
      try {
        await Promise.all([geo.ensureRuleset('dd'), geo.ensureRuleset('dd'), geo.ensureRuleset('dd')]);
      } finally {
        globalThis.DecompressionStream = OriginalDS;
      }
      assert.equal(inflateCalls, 1);
      assert.equal(geo.inRuleset('dd', 'x.dedupe.example', []), true);
    },
  },
  {
    name: 'geo: ensureRuleset failure sets lastError and allows retry',
    run: async () => {
      idbData.clear();
      await saveBlob('ruleset:bad', new TextEncoder().encode('garbage'), { bodyHash: 'e'.repeat(64) });
      await geo.reloadAll(['bad']);
      assert.equal(geo.rulesetsStatus().find(r => r.name === 'bad').error, null);

      await assert.rejects(() => geo.ensureRuleset('bad'), /not a valid/);
      assert.match(geo.rulesetsStatus().find(r => r.name === 'bad').error, /not a valid/);
      assert.equal(geo.inRuleset('bad', 'x', []), null);
      const status = geo.status().rulesets.find(r => r.name === 'bad');
      assert.match(status.error, /not a valid/);

      await assert.rejects(() => geo.ensureRuleset('bad'), /not a valid/);

      const good = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['fixed.example'] }) }],
      });
      await saveBlob('ruleset:bad', good, { bodyHash: 'f'.repeat(64) });
      assert.ok(await geo.reloadRuleset('bad'));
      assert.equal(geo.inRuleset('bad', 'a.fixed.example', []), true);
      assert.equal(geo.rulesetsStatus().find(r => r.name === 'bad').error, null);
    },
  },
  {
    name: 'matcher: ruleset type with UNDECIDED when unloaded',
    run: () => {
      const fakeGeo = {
        inRuleset(name, host, ips) {
          if (name !== 'loaded') return null;
          return host === 'hit.example' || ips.some(ip => ip.bytes[0] === 9);
        },
      };
      assert.equal(matches({ type: 'ruleset', tag: 'loaded' }, { host: 'hit.example', ips: [] }, fakeGeo), true);
      assert.equal(matches({ type: 'ruleset', tag: 'loaded' }, { host: 'miss.example', ips: [parseIp('9.9.9.9')] }, fakeGeo), true);
      assert.equal(matches({ type: 'ruleset', tag: 'loaded' }, { host: 'miss.example', ips: [parseIp('8.8.8.8')] }, fakeGeo), false);
      const trace = [];
      assert.equal(matches({ type: 'ruleset', tag: 'absent' }, { host: 'x', ips: [] }, fakeGeo, trace), UNDECIDED);
      assert.equal(trace[0].hit, null);
      assert.equal(trace[0].note, 'ruleset not loaded');
      assert.equal(matches({ type: 'ruleset', tag: '' }, { host: 'x' }, fakeGeo), false);
    },
  },
  {
    name: 'config: rulesets validation',
    run: () => {
      const base = mergeWithDefaults({});
      assert.deepEqual(base.data_sources.rulesets, {});
      assert.equal(validateConfig(base).ok, true);

      const good = mergeWithDefaults({
        data_sources: { rulesets: { 'my-set_1': { url: 'https://x.example/a.srs' } } },
      });
      assert.equal(validateConfig(good).ok, true);
      assert.equal(good.data_sources.rulesets['my-set_1'].auto_update, true);
      assert.equal(good.data_sources.rulesets['my-set_1'].interval_hours, 24);

      const badName = mergeWithDefaults({ data_sources: { rulesets: { '.bad': { url: '' } } } });
      assert.equal(validateConfig(badName).ok, false);

      const badUrl = mergeWithDefaults({ data_sources: { rulesets: { ok: { url: 'http://insecure/' } } } });
      assert.equal(validateConfig(badUrl).ok, false);

      const tooMany = mergeWithDefaults({
        data_sources: { rulesets: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`n${i}`, { url: '' }])) },
      });
      assert.equal(validateConfig(tooMany).ok, false);
    },
  },
  {
    name: 'config: ruleset matcher type validation',
    run: () => {
      const withMatcher = tag => mergeWithDefaults({
        rules: [{ source: { type: 'any' }, destination: { type: 'ruleset', tag } }],
      });
      assert.equal(validateConfig(withMatcher('ads')).ok, true);
      assert.equal(validateConfig(withMatcher('')).ok, false);
    },
  },
  {
    name: 'updater: ruleset flow with validation and reload',
    run: async () => {
      idbData.clear();
      localStore.clear();
      const config = await loadConfig();
      config.data_sources.rulesets = { ads: { url: 'https://rs.example/ads.srs', sha256_url: '', auto_update: true, interval_hours: 24 } };
      await saveConfig(config);

      const good = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['upd.example'] }) }],
      });
      await withFetch(async () => ({ ok: true, status: 200, arrayBuffer: async () => good.buffer.slice(0) }),
        async () => {
          const result = await updater.updateRuleset('ads');
          assert.equal(result.unchanged, false);
        });
      assert.ok(idbData.get('ruleset:ads'));
      assert.equal(geo.inRuleset('ads', 'a.upd.example', []), true);
      assert.equal(updater.getLastError('ruleset:ads'), null);

      await withFetch(async () => ({ ok: true, status: 200, arrayBuffer: async () => good.buffer.slice(0) }),
        async () => {
          const result = await updater.updateRuleset('ads');
          assert.equal(result.unchanged, true);
        });

      const garbage = new TextEncoder().encode('x'.repeat(64));
      await withFetch(async () => ({ ok: true, status: 200, arrayBuffer: async () => garbage.buffer.slice(0) }),
        () => assert.rejects(() => updater.updateRuleset('ads'), /parse failed/));
      assert.equal(geo.inRuleset('ads', 'a.upd.example', []), true);
      assert.match(updater.getLastError('ruleset:ads'), /parse failed/);
      assert.match(updater.getRulesetErrors().ads, /parse failed/);
    },
  },
  {
    name: 'updater: updateIfStale for ruleset streams',
    run: async () => {
      idbData.clear();
      localStore.clear();
      const config = await loadConfig();
      config.data_sources.rulesets = { fresh: { url: 'https://rs.example/f.srs', sha256_url: '', auto_update: true, interval_hours: 24 } };
      await saveConfig(config);
      idbData.set('ruleset:fresh:meta', { key: 'ruleset:fresh:meta', bodyHash: 'z'.repeat(64), savedAt: Date.now() });
      assert.deepEqual(await updater.updateIfStale('ruleset:fresh'), { skipped: 'fresh' });

      config.data_sources.rulesets.fresh.auto_update = false;
      await saveConfig(config);
      assert.deepEqual(await updater.updateIfStale('ruleset:fresh'), { skipped: 'disabled' });

      config.data_sources.rulesets.fresh.auto_update = true;
      await saveConfig(config);
      idbData.delete('ruleset:fresh:meta');
      const bigger = buildSrs({
        rules: [{ write: w => writeDomainSetItem(w, { suffixes: ['stale.example'] }) }],
      });
      await withFetch(async () => ({ ok: true, status: 200, arrayBuffer: async () => bigger.buffer.slice(0) }),
        async () => {
          const result = await updater.updateIfStale('ruleset:fresh');
          assert.equal(result.unchanged, false);
        });
    },
  },
];
