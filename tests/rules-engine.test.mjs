import { strict as assert } from 'node:assert';
import { evaluate } from '../worker/rules-engine.js';
import { parseIp } from '../lib/ip.js';

const geo = {
  inGeoipTag(ip, tag) {
    if (!ip) return false;
    if (ip.bytes[0] === 1 && ip.bytes[1] === 1) return tag === 'cn';
    return false;
  },
  inGeositeTag(host, tag) {
    if (tag === 'google' && host.endsWith('search.example')) return true;
    return false;
  },
};

function preResolved() {
  return { resolveSource: async () => {}, resolveDestination: async () => {} };
}

export const tests = [
  {
    name: 'falls back to default when no rules',
    run: async () => {
      const result = await evaluate({ default_action: 'allow', rules: [] }, {
        source: { host: 'a.com' },
        destination: { host: 'b.com' },
      }, geo);
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
  {
    name: 'block rule fires when both sides match',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'geosite', tag: 'google' },
          destination: { type: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'mail.search.example' },
        destination: { host: 'cdn', ips: [parseIp('1.1.1.1')] },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.index, 0);
    },
  },
  {
    name: 'allow rule overrides default block',
    run: async () => {
      const config = {
        default_action: 'block',
        rules: [{
          enabled: true,
          source: { type: 'any' },
          destination: { type: 'domain', regex: 'safe' },
          action: 'allow',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'a' },
        destination: { host: 'safe.example' },
      }, geo);
      assert.equal(result.verdict, 'allow');
    },
  },
  {
    name: 'first matching rule wins',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' },
          { enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'allow' },
        ],
      };
      const result = await evaluate(config, {
        source: { host: 'a' }, destination: { host: 'b' },
      }, geo);
      assert.equal(result.matchedRule.index, 0);
    },
  },
  {
    name: 'disabled rule skipped',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{ enabled: false, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const result = await evaluate(config, { source: { host: 'a' }, destination: { host: 'b' } }, geo);
      assert.equal(result.verdict, 'allow');
    },
  },
  {
    name: 'trace records each rule attempt',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, source: { type: 'geosite', tag: 'google' }, destination: { type: 'any' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, { source: { host: 'example.com' }, destination: { host: 'r' } }, geo, {}, { trace: true });
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0].sourceHit, false);
      assert.equal(result.trace[0].destinationHit, null);
    },
  },
  {
    name: 'lazy: geosite-only config never calls resolvers',
    run: async () => {
      let sourceCalls = 0;
      let destinationCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'geosite', tag: 'google' }, action: 'block' }],
      };
      const result = await evaluate(config, {
        source: { host: 'site' }, destination: { host: 'mail.search.example' },
      }, geo, {
        resolveSource: async () => { sourceCalls += 1; },
        resolveDestination: async () => { destinationCalls += 1; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(sourceCalls, 0);
      assert.equal(destinationCalls, 0);
    },
  },
  {
    name: 'lazy: geoip rule reached triggers destination resolver',
    run: async () => {
      let destinationCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'geoip', tag: 'cn' }, action: 'block' }],
      };
      const ctx = { source: { host: 'a' }, destination: { host: 'cdn', ips: [] } };
      const result = await evaluate(config, ctx, geo, {
        resolveDestination: async c => { destinationCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(destinationCalls, 1);
    },
  },
  {
    name: 'lazy: earlier geosite hit prevents later geoip resolution',
    run: async () => {
      let destinationCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, source: { type: 'any' }, destination: { type: 'geosite', tag: 'google' }, action: 'block' },
          { enabled: true, source: { type: 'any' }, destination: { type: 'geoip', tag: 'cn' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, {
        source: { host: 'a' }, destination: { host: 'mail.search.example' },
      }, geo, {
        resolveDestination: async c => { destinationCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(destinationCalls, 0);
    },
  },
  {
    name: 'lazy: multiple geoip rules resolve destination only once',
    run: async () => {
      let destinationCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, source: { type: 'any' }, destination: { type: 'geoip', tag: 'us' }, action: 'block' },
          { enabled: true, source: { type: 'any' }, destination: { type: 'geoip', tag: 'cn' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, {
        source: { host: 'a' }, destination: { host: 'cdn', ips: [] },
      }, geo, {
        resolveDestination: async c => { destinationCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(destinationCalls, 1);
    },
  },
  {
    name: 'lazy: ruleset matcher triggers DNS resolution',
    run: async () => {
      let resolved = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'r' }, action: 'block' }],
      };
      await evaluate(config, {
        source: { host: 'a', ips: [] }, destination: { host: 'b', ips: [] },
      }, { ...geo, inRuleset: () => false }, {
        resolveSource: async () => {},
        resolveDestination: async () => { resolved += 1; },
        ensureRuleset: async () => {},
      });
      assert.equal(resolved, 1);
    },
  },
  {
    name: 'lazy: ensureRuleset awaited before ruleset rule evaluates',
    run: async () => {
      let built = false;
      const ensured = [];
      const lazyGeo = {
        ...geo,
        inRuleset(name, host) {
          if (name !== 'ads' || !built) return null;
          return host === 'blocked.example';
        },
      };
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'ads' }, action: 'block' }],
      };
      const result = await evaluate(config, {
        source: { host: 'a' }, destination: { host: 'blocked.example' },
      }, lazyGeo, {
        ensureRuleset: async name => { ensured.push(name); built = true; },
      });
      assert.equal(result.verdict, 'block');
      assert.deepEqual(ensured, ['ads']);
    },
  },
  {
    name: 'lazy: ruleset tags collected from nested and/or/not, ensured once per tag',
    run: async () => {
      const ensured = [];
      const lazyGeo = { ...geo, inRuleset: () => false };
      const config = {
        default_action: 'allow',
        rules: [
          {
            enabled: true,
            source: { type: 'not', match: { type: 'rule-set', tag: 'a' } },
            destination: {
              type: 'and',
              matches: [
                { type: 'or', matches: [{ type: 'rule-set', tag: 'b' }, { type: 'rule-set', tag: 'a' }] },
                { type: 'any' },
              ],
            },
            action: 'block',
          },
          { enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'a' }, action: 'block' },
        ],
      };
      await evaluate(config, { source: { host: 'x' }, destination: { host: 'y' } }, lazyGeo, {
        ensureRuleset: async name => { ensured.push(name); },
      });
      assert.deepEqual(ensured.sort(), ['a', 'b']);
    },
  },
  {
    name: 'lazy: uppercase ruleset tag is ensured lowercase',
    run: async () => {
      const ensured = [];
      const lazyGeo = { ...geo, inRuleset: () => false };
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'ADS' }, action: 'block' }],
      };
      await evaluate(config, { source: { host: 'x' }, destination: { host: 'y' } }, lazyGeo, {
        ensureRuleset: async name => { ensured.push(name); },
      });
      assert.deepEqual(ensured, ['ads']);
    },
  },
  {
    name: 'lazy: ruleset rules not reached do not trigger ensureRuleset',
    run: async () => {
      const ensured = [];
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' },
          { enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'later' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, { source: { host: 'x' }, destination: { host: 'y' } }, geo, {
        ensureRuleset: async name => { ensured.push(name); },
      });
      assert.equal(result.verdict, 'block');
      assert.deepEqual(ensured, []);
    },
  },
  {
    name: 'lazy: ensureRuleset failure leaves rule UNDECIDED and continues',
    run: async () => {
      const lazyGeo = { ...geo, inRuleset: () => null };
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'rule-set', tag: 'broken' }, action: 'block' }],
      };
      const result = await evaluate(config, { source: { host: 'x' }, destination: { host: 'y' } }, lazyGeo, {
        ensureRuleset: async () => { throw new Error('decode failed'); },
      });
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
  {
    name: 'lazy: not-geoip triggers resolver',
    run: async () => {
      let sourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'not', match: { type: 'geoip', tag: 'cn' } },
          destination: { type: 'any' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'a', ips: [] }, destination: { host: 'b' },
      }, geo, {
        resolveSource: async c => { sourceCalls += 1; c.ips = [parseIp('8.8.8.8')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(sourceCalls, 1);
    },
  },
  {
    name: 'lazy: disabled geoip rule does not trigger resolver',
    run: async () => {
      let destinationCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: false, source: { type: 'any' }, destination: { type: 'geoip', tag: 'cn' }, action: 'block' }],
      };
      const result = await evaluate(config, {
        source: { host: 'a' }, destination: { host: 'cdn' },
      }, geo, {
        resolveDestination: async () => { destinationCalls += 1; },
      });
      assert.equal(result.verdict, 'allow');
      assert.equal(destinationCalls, 0);
    },
  },
  {
    name: 'bidirectional rule matches forward direction',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          bidirectional: true,
          source: { type: 'geosite', tag: 'google' },
          destination: { type: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'mail.search.example' },
        destination: { host: 'cdn', ips: [parseIp('1.1.1.1')] },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.direction, 'forward');
    },
  },
  {
    name: 'bidirectional rule matches reverse direction',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          bidirectional: true,
          source: { type: 'geosite', tag: 'google' },
          destination: { type: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'chat.example', ips: [parseIp('1.1.1.1')] },
        destination: { host: 'mail.search.example' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.direction, 'reverse');
    },
  },
  {
    name: 'bidirectional NOT does not fire when source host empty (peel reproducer)',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          bidirectional: true,
          name: 'RU',
          source: { type: 'geosite', tag: 'google' },
          destination: { type: 'not', match: { type: 'geosite', tag: 'google' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: '', url: '', ips: [] },
        destination: { host: 'mail.search.example', url: 'https://mail.search.example/', ips: [] },
      }, geo, preResolved());
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
  {
    name: 'forward NOT geoip does not fire when ips empty',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'any' },
          destination: { type: 'not', match: { type: 'geoip', tag: 'cn' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'a' },
        destination: { host: 'b', ips: [] },
      }, geo, preResolved());
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
  {
    name: 'NOT subtree with present data still fires normally',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'any' },
          destination: { type: 'not', match: { type: 'geosite', tag: 'google' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'a' },
        destination: { host: 'example.com' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'rule fires when only destination side has data',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'any' },
          destination: { type: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: '' },
        destination: { host: 'mail.search.example' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'trace: UNDECIDED source yields null hits and no destination subtree',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          source: { type: 'geosite', tag: 'google' },
          destination: { type: 'any' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: '' },
        destination: { host: 'b' },
      }, geo, preResolved(), { trace: true });
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0].sourceHit, null);
      assert.equal(result.trace[0].destinationHit, null);
      assert.equal(result.trace[0].destinationTrace, null);
    },
  },
  {
    name: 'isolate fires when source in set, destination out of set',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          mode: 'isolate',
          match: { type: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'mail.search.example' },
        destination: { host: 'example.com' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.index, 0);
    },
  },
  {
    name: 'isolate fires when destination in set, source out of set (reverse)',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          mode: 'isolate',
          match: { type: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'example.com' },
        destination: { host: 'mail.search.example' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.direction, 'reverse');
    },
  },
  {
    name: 'isolate does NOT fire when both sides in set',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          mode: 'isolate',
          match: { type: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'mail.search.example' },
        destination: { host: 'docs.search.example' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
  {
    name: 'isolate does NOT fire when neither side in set',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          mode: 'isolate',
          match: { type: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        source: { host: 'a.example' },
        destination: { host: 'b.example' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'allow');
      assert.equal(result.matchedRule, null);
    },
  },
];
