import { strict as assert } from 'node:assert';
import { defaultConfig, validateConfig, mergeWithDefaults } from '../worker/config.js';

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
        website: { kind: 'any' },
        resource: { kind: 'ip', cidr: 'nonsense' },
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
        website: { kind: 'any' },
        resource: {
          kind: 'all_of',
          terms: [
            { kind: 'geosite', tag: 'google' },
            { kind: 'not', term: { kind: 'domain', regex: 'safe' } },
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
        website: { kind: 'domain', regex: '[' },
        resource: { kind: 'any' },
      });
      const result = validateConfig(config);
      assert.equal(result.ok, false);
    },
  },
  {
    name: 'mergeWithDefaults fills missing fields',
    run: () => {
      const merged = mergeWithDefaults({ rules: [{ action: 'allow', website: { kind: 'any' }, resource: { kind: 'any' } }] });
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
];
