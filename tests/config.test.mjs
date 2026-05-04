import { strict as assert } from 'node:assert';

const localStore = new Map();
let localSetCalls = 0;
globalThis.browser = {
  storage: {
    local: {
      get: async key => {
        if (typeof key === 'string') {
          return localStore.has(key) ? { [key]: localStore.get(key) } : {};
        }
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (localStore.has(k)) out[k] = localStore.get(k);
          return out;
        }
        return {};
      },
      set: async obj => {
        localSetCalls += 1;
        for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
      },
    },
  },
};

const { defaultConfig, validateConfig, mergeWithDefaults, desugarRule, loadConfig } = await import('../worker/config.js');

export const tests = [
  {
    name: 'defaultConfig validates',
    run: () => {
      const result = validateConfig(defaultConfig());
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'rejects missing action',
    run: () => {
      const config = defaultConfig();
      config.default_action = 'maybe';
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(error => error.path === '/default_action'));
    },
  },
  {
    name: 'rejects bad cidr',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'any' },
        destination: { type: 'ip', cidr: 'nonsense' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(error => error.path.endsWith('/cidr')));
    },
  },
  {
    name: 'accepts composite matcher',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'any' },
        destination: {
          type: 'and',
          matches: [
            { type: 'geosite', tag: 'google' },
            { type: 'not', match: { type: 'domain', regex: 'safe' } },
          ],
        },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'rejects bad regex',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'domain', regex: '[' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
    },
  },
  {
    name: 'accepts url matcher',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'any' },
        destination: { type: 'url', regex: '^https://example\\.com/api/' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'rejects empty url regex',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'url', regex: '' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(error => error.path.endsWith('/regex')));
    },
  },
  {
    name: 'rejects invalid url regex',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block',
        source: { type: 'url', regex: '[' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
    },
  },
  {
    name: 'mergeWithDefaults fills missing fields',
    run: () => {
      const merged = mergeWithDefaults({ rules: [{ action: 'allow', source: { type: 'any' }, destination: { type: 'any' } }] });
      assert.equal(merged.default_action, 'allow');
      assert.equal(merged.rules.length, 1);
      assert.equal(merged.rules[0].enabled, true);
    },
  },
  {
    name: 'rejects non-https URL',
    run: () => {
      const config = defaultConfig();
      config.data_sources.geoip.url = 'http://example.com/geoip.dat';
      const result = validateConfig(config);
      assert.equal(result.ok, false);
    },
  },
  {
    name: 'rejects bad dns match_strategy',
    run: () => {
      const config = defaultConfig();
      config.dns.match_strategy = 'bogus';
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path === '/dns/match_strategy'));
    },
  },
  {
    name: 'rejects missing dns block',
    run: () => {
      const config = defaultConfig();
      delete config.dns;
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path === '/dns'));
    },
  },
  {
    name: 'rejects out-of-range dns cache_ttl_seconds',
    run: () => {
      const config = defaultConfig();
      config.dns.cache_ttl_seconds = -1;
      assert.equal(validateConfig(config).ok, false);
      config.dns.cache_ttl_seconds = 100000;
      assert.equal(validateConfig(config).ok, false);
    },
  },
  {
    name: 'accepts strip_referrer flag',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block', strip_referrer: true,
        source: { type: 'any' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'rejects non-boolean strip_referrer',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'block', strip_referrer: 'yes',
        source: { type: 'any' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path.endsWith('/strip_referrer')));
    },
  },
  {
    name: 'mergeWithDefaults defaults strip_referrer to false',
    run: () => {
      const merged = mergeWithDefaults({ rules: [{ action: 'block', source: { type: 'any' }, destination: { type: 'any' } }] });
      assert.equal(merged.rules[0].strip_referrer, false);
    },
  },
  {
    name: 'mergeWithDefaults preserves strip_referrer true',
    run: () => {
      const merged = mergeWithDefaults({ rules: [{ action: 'block', strip_referrer: true, source: { type: 'any' }, destination: { type: 'any' } }] });
      assert.equal(merged.rules[0].strip_referrer, true);
    },
  },
  {
    name: 'rejects strip_referrer: true with action: allow',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true, action: 'allow', strip_referrer: true,
        source: { type: 'any' },
        destination: { type: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      const err = result.errors.find(e => e.path.endsWith('/strip_referrer'));
      assert.ok(err);
      assert.match(err.message, /requires action: block/);
    },
  },
  {
    name: 'rejects isolate strip_referrer: true with action: allow',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'isolate',
        match: { type: 'any' },
        action: 'allow',
        strip_referrer: true,
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path.endsWith('/strip_referrer')));
    },
  },
  {
    name: 'isolate rule validates with minimal fields',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'isolate',
        match: { type: 'geoip', tag: 'cn' },
        action: 'block',
      });
      const result = validateConfig(config);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'isolate rule accepts strip_referrer',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'isolate',
        match: { type: 'geoip', tag: 'cn' },
        action: 'block',
        strip_referrer: true,
      });
      const result = validateConfig(config);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    },
  },
  {
    name: 'isolate rule rejects missing match',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'isolate',
        action: 'block',
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path.endsWith('/match')));
    },
  },
  {
    name: 'isolate rule rejects extra source/destination/bidirectional fields',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'isolate',
        match: { type: 'any' },
        source: { type: 'any' },
        destination: { type: 'any' },
        bidirectional: true,
        action: 'block',
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path.endsWith('/source')));
      assert.ok(result.errors.find(e => e.path.endsWith('/destination')));
      assert.ok(result.errors.find(e => e.path.endsWith('/bidirectional')));
    },
  },
  {
    name: 'unknown mode value rejected with clear error',
    run: () => {
      const config = defaultConfig();
      config.rules.push({
        enabled: true,
        mode: 'foo',
        source: { type: 'any' },
        destination: { type: 'any' },
        action: 'block',
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
      const err = result.errors.find(e => e.path.endsWith('/mode'));
      assert.ok(err);
      assert.match(err.message, /isolate/);
    },
  },
  {
    name: 'desugarRule converts isolate to bidirectional flow with NOT(match)',
    run: () => {
      const isolate = {
        name: 'cross-cn',
        enabled: true,
        mode: 'isolate',
        match: { type: 'geoip', tag: 'cn' },
        action: 'block',
      };
      const flow = desugarRule(isolate);
      assert.equal(flow.bidirectional, true);
      assert.deepEqual(flow.source, { type: 'geoip', tag: 'cn' });
      assert.deepEqual(flow.destination, { type: 'not', match: { type: 'geoip', tag: 'cn' } });
      assert.equal(flow.action, 'block');
      assert.equal(flow.name, 'cross-cn');
    },
  },
  {
    name: 'desugarRule preserves strip_referrer on isolate',
    run: () => {
      const isolate = {
        mode: 'isolate',
        enabled: true,
        match: { type: 'any' },
        action: 'block',
        strip_referrer: true,
      };
      const flow = desugarRule(isolate);
      assert.equal(flow.strip_referrer, true);
    },
  },
  {
    name: 'desugarRule passes flow rules through unchanged',
    run: () => {
      const flow = {
        enabled: true, action: 'block',
        source: { type: 'any' },
        destination: { type: 'any' },
      };
      assert.equal(desugarRule(flow), flow);
    },
  },
  {
    name: 'mergeWithDefaults preserves isolate mode',
    run: () => {
      const merged = mergeWithDefaults({
        rules: [{ mode: 'isolate', action: 'block', match: { type: 'geoip', tag: 'cn' } }],
      });
      assert.equal(merged.rules[0].mode, 'isolate');
      assert.deepEqual(merged.rules[0].match, { type: 'geoip', tag: 'cn' });
      assert.equal('source' in merged.rules[0], false);
      assert.equal('destination' in merged.rules[0], false);
    },
  },
  {
    name: 'validateConfig: rejects v1 fields (website/resource) as unknown',
    run: () => {
      const merged = mergeWithDefaults({});
      merged.rules = [{
        name: '', enabled: true, action: 'block', strip_referrer: false, bidirectional: false,
        source: { type: 'any' }, destination: { type: 'any' },
        website: {},
        resource: {},
      }];
      const result = validateConfig(merged);
      assert.equal(result.ok, false);
      assert.ok(result.errors.find(e => e.path === '/rules/0/website' && e.message === 'unknown field'));
      assert.ok(result.errors.find(e => e.path === '/rules/0/resource' && e.message === 'unknown field'));
    },
  },
  {
    name: 'validateConfig: v1 input rejected with clear migration message',
    run: () => {
      const result = validateConfig({
        version: 1,
        default_action: 'allow',
        data_sources: { geoip: { url: '', auto_update: true, interval_hours: 24 }, geosite: { url: '', auto_update: true, interval_hours: 24 } },
        dns: { cache_ttl_seconds: 300, negative_cache_ttl_seconds: 30, timeout_ms: 1500, match_strategy: 'first' },
        rules: [],
      });
      assert.equal(result.ok, false);
      const err = result.errors.find(e => e.path === '/version');
      assert.ok(err);
      assert.match(err.message, /legacy v1/);
    },
  },
  {
    name: 'loadConfig: empty storage seeds default config and persists it',
    run: async () => {
      localStore.clear();
      localSetCalls = 0;
      const config = await loadConfig();
      assert.equal(config.version, 2);
      assert.equal(localSetCalls, 1, 'fresh default must be persisted');
      assert.ok(localStore.has('config'));
    },
  },
  {
    name: 'loadConfig: v1 storage migrates to v2 silently and re-persists',
    run: async () => {
      localStore.clear();
      localStore.set('config', {
        version: 1,
        default_action: 'allow',
        rules: [{
          enabled: true,
          action: 'block',
          website: { kind: 'domain', regex: 'foo' },
          resource: { kind: 'any' },
        }],
      });
      localSetCalls = 0;
      const config = await loadConfig();
      assert.equal(config.version, 2);
      assert.deepEqual(config.rules[0].source, { type: 'domain', regex: 'foo' });
      assert.equal('website' in config.rules[0], false);
      assert.equal(localSetCalls, 1);
      assert.equal(localStore.get('config').version, 2);
    },
  },
  {
    name: 'loadConfig: v2 storage does not re-persist',
    run: async () => {
      localStore.clear();
      const fresh = defaultConfig();
      localStore.set('config', fresh);
      localSetCalls = 0;
      await loadConfig();
      assert.equal(localSetCalls, 0, 'matching version must not trigger a write');
    },
  },
];
