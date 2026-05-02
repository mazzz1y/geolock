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
    if (tag === 'google' && host.endsWith('google.com')) return true;
    return false;
  },
};

function preResolved() {
  return { resolveWebsite: async () => {}, resolveResource: async () => {} };
}

export const tests = [
  {
    name: 'falls back to default when no rules',
    run: async () => {
      const result = await evaluate({ default_action: 'allow', rules: [] }, {
        website: { host: 'a.com' },
        resource: { host: 'b.com' },
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
          website: { kind: 'geosite', tag: 'google' },
          resource: { kind: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'mail.google.com' },
        resource: { host: 'cdn', ips: [parseIp('1.1.1.1')] },
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
          website: { kind: 'any' },
          resource: { kind: 'domain', regex: 'safe' },
          action: 'allow',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'a' },
        resource: { host: 'safe.example' },
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
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'any' }, action: 'block' },
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'any' }, action: 'allow' },
        ],
      };
      const result = await evaluate(config, {
        website: { host: 'a' }, resource: { host: 'b' },
      }, geo);
      assert.equal(result.matchedRule.index, 0);
    },
  },
  {
    name: 'disabled rule skipped',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{ enabled: false, website: { kind: 'any' }, resource: { kind: 'any' }, action: 'block' }],
      };
      const result = await evaluate(config, { website: { host: 'a' }, resource: { host: 'b' } }, geo);
      assert.equal(result.verdict, 'allow');
    },
  },
  {
    name: 'trace records each rule attempt',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, website: { kind: 'geosite', tag: 'google' }, resource: { kind: 'any' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, { website: { host: 'example.com' }, resource: { host: 'r' } }, geo, {}, { trace: true });
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0].websiteHit, false);
      assert.equal(result.trace[0].resourceHit, null);
    },
  },
  {
    name: 'lazy: geosite-only config never calls resolvers',
    run: async () => {
      let websiteCalls = 0;
      let resourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, website: { kind: 'any' }, resource: { kind: 'geosite', tag: 'google' }, action: 'block' }],
      };
      const result = await evaluate(config, {
        website: { host: 'site' }, resource: { host: 'mail.google.com' },
      }, geo, {
        resolveWebsite: async () => { websiteCalls += 1; },
        resolveResource: async () => { resourceCalls += 1; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(websiteCalls, 0);
      assert.equal(resourceCalls, 0);
    },
  },
  {
    name: 'lazy: geoip rule reached triggers resource resolver',
    run: async () => {
      let resourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: true, website: { kind: 'any' }, resource: { kind: 'geoip', tag: 'cn' }, action: 'block' }],
      };
      const ctx = { website: { host: 'a' }, resource: { host: 'cdn', ips: [] } };
      const result = await evaluate(config, ctx, geo, {
        resolveResource: async c => { resourceCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(resourceCalls, 1);
    },
  },
  {
    name: 'lazy: earlier geosite hit prevents later geoip resolution',
    run: async () => {
      let resourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'geosite', tag: 'google' }, action: 'block' },
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'geoip', tag: 'cn' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, {
        website: { host: 'a' }, resource: { host: 'mail.google.com' },
      }, geo, {
        resolveResource: async c => { resourceCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(resourceCalls, 0);
    },
  },
  {
    name: 'lazy: multiple geoip rules resolve resource only once',
    run: async () => {
      let resourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'geoip', tag: 'us' }, action: 'block' },
          { enabled: true, website: { kind: 'any' }, resource: { kind: 'geoip', tag: 'cn' }, action: 'block' },
        ],
      };
      const result = await evaluate(config, {
        website: { host: 'a' }, resource: { host: 'cdn', ips: [] },
      }, geo, {
        resolveResource: async c => { resourceCalls += 1; c.ips = [parseIp('1.1.1.1')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(resourceCalls, 1);
    },
  },
  {
    name: 'lazy: not-geoip triggers resolver',
    run: async () => {
      let websiteCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          website: { kind: 'not', term: { kind: 'geoip', tag: 'cn' } },
          resource: { kind: 'any' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'a', ips: [] }, resource: { host: 'b' },
      }, geo, {
        resolveWebsite: async c => { websiteCalls += 1; c.ips = [parseIp('8.8.8.8')]; },
      });
      assert.equal(result.verdict, 'block');
      assert.equal(websiteCalls, 1);
    },
  },
  {
    name: 'lazy: disabled geoip rule does not trigger resolver',
    run: async () => {
      let resourceCalls = 0;
      const config = {
        default_action: 'allow',
        rules: [{ enabled: false, website: { kind: 'any' }, resource: { kind: 'geoip', tag: 'cn' }, action: 'block' }],
      };
      const result = await evaluate(config, {
        website: { host: 'a' }, resource: { host: 'cdn' },
      }, geo, {
        resolveResource: async () => { resourceCalls += 1; },
      });
      assert.equal(result.verdict, 'allow');
      assert.equal(resourceCalls, 0);
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
          website: { kind: 'geosite', tag: 'google' },
          resource: { kind: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'mail.google.com' },
        resource: { host: 'cdn', ips: [parseIp('1.1.1.1')] },
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
          website: { kind: 'geosite', tag: 'google' },
          resource: { kind: 'geoip', tag: 'cn' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'qq.com', ips: [parseIp('1.1.1.1')] },
        resource: { host: 'mail.google.com' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.direction, 'reverse');
    },
  },
  {
    name: 'bidirectional NOT does not fire when website host empty (peel reproducer)',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          bidirectional: true,
          name: 'RU',
          website: { kind: 'geosite', tag: 'google' },
          resource: { kind: 'not', term: { kind: 'geosite', tag: 'google' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: '', url: '', ips: [] },
        resource: { host: 'mail.google.com', url: 'https://mail.google.com/', ips: [] },
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
          website: { kind: 'any' },
          resource: { kind: 'not', term: { kind: 'geoip', tag: 'cn' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'a' },
        resource: { host: 'b', ips: [] },
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
          website: { kind: 'any' },
          resource: { kind: 'not', term: { kind: 'geosite', tag: 'google' } },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: 'a' },
        resource: { host: 'example.com' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'rule fires when only resource side has data',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          website: { kind: 'any' },
          resource: { kind: 'geosite', tag: 'google' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: '' },
        resource: { host: 'mail.google.com' },
      }, geo, preResolved());
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'trace: UNDECIDED website yields null hits and no resource subtree',
    run: async () => {
      const config = {
        default_action: 'allow',
        rules: [{
          enabled: true,
          website: { kind: 'geosite', tag: 'google' },
          resource: { kind: 'any' },
          action: 'block',
        }],
      };
      const result = await evaluate(config, {
        website: { host: '' },
        resource: { host: 'b' },
      }, geo, preResolved(), { trace: true });
      assert.equal(result.trace.length, 1);
      assert.equal(result.trace[0].websiteHit, null);
      assert.equal(result.trace[0].resourceHit, null);
      assert.equal(result.trace[0].resourceTrace, null);
    },
  },
];
