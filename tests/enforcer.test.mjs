import assert from 'node:assert/strict';
import { deriveSourceContext, evaluateRequest, cachePutVerdict, cacheTakeVerdict, _verdictCacheSize, _hasStripRule, _isReady, markReady, setConfig, probe } from '../worker/enforcer.js';
import * as geo from '../worker/geo/index.js';
import { parseIp } from '../lib/ip.js';

await geo.reloadAll().catch(() => {});

function framesWith(tabId, frameId, frame) {
  const inner = new Map([[frameId, frame]]);
  return new Map([[tabId, inner]]);
}

const allowAllConfig = { default_action: 'allow', rules: [], dns: { match_strategy: 'all' } };
const blockGeoipCnConfig = {
  default_action: 'allow',
  dns: { match_strategy: 'all' },
  rules: [{
    enabled: true,
    source: { type: 'any' },
    destination: { type: 'geoip', tag: 'cn' },
    action: 'block',
  }],
};

const fakeGeo = {
  inGeoipTag(ip, tag) {
    if (!ip) return false;
    if (ip.bytes[0] === 1 && ip.bytes[1] === 1) return tag === 'cn';
    if (ip.bytes[0] === 8) return tag === 'us';
    return false;
  },
  inGeositeTag() { return false; },
};

const baseDeps = (overrides = {}) => ({
  config: allowAllConfig,
  geo: fakeGeo,
  dnsLookup: async () => [],
  frames: new Map(),
  selfOriginPrefix: 'moz-extension://abc/',
  ...overrides,
});

export const tests = [
  {
    name: 'tabId>=0 with matching frame uses frame host',
    run: () => {
      const frames = framesWith(7, 2, { host: 'iframe.example', url: 'https://iframe.example/x', parentFrameId: 0 });
      const ctx = deriveSourceContext({ tabId: 7, frameId: 2, url: 'https://r.example/y' }, frames);
      assert.equal(ctx.host, 'iframe.example');
      assert.equal(ctx.url, 'https://iframe.example/x');
    },
  },
  {
    name: 'tabId>=0 frame missing falls back to top frame',
    run: () => {
      const frames = framesWith(3, 0, { host: 'top.example', url: 'https://top.example/', parentFrameId: -1 });
      const ctx = deriveSourceContext({ tabId: 3, frameId: 99, url: 'https://r/' }, frames);
      assert.equal(ctx.host, 'top.example');
    },
  },
  {
    name: 'tabId>=0 no frame map falls back to documentUrl',
    run: () => {
      const ctx = deriveSourceContext({
        tabId: 5,
        frameId: 0,
        documentUrl: 'https://owner.example/page',
        url: 'https://r/',
      }, new Map());
      assert.equal(ctx.host, 'owner.example');
      assert.equal(ctx.url, 'https://owner.example/page');
    },
  },
  {
    name: 'tabId<0 uses documentUrl',
    run: () => {
      const ctx = deriveSourceContext({
        tabId: -1,
        frameId: -1,
        documentUrl: 'https://doc.example/p',
        originUrl: 'https://other.example/sw.js',
        url: 'https://r/',
      }, new Map());
      assert.equal(ctx.host, 'doc.example');
    },
  },
  {
    name: 'tabId<0 no documentUrl uses originUrl',
    run: () => {
      const ctx = deriveSourceContext({
        tabId: -1,
        frameId: -1,
        documentUrl: '',
        originUrl: 'https://sw.example/sw.js',
        url: 'https://r/',
      }, new Map());
      assert.equal(ctx.host, 'sw.example');
      assert.equal(ctx.url, 'https://sw.example/sw.js');
    },
  },
  {
    name: 'tabId<0 only initiator falls back to it',
    run: () => {
      const ctx = deriveSourceContext({
        tabId: -1,
        frameId: -1,
        initiator: 'https://init.example',
        url: 'https://r/',
      }, new Map());
      assert.equal(ctx.host, 'init.example');
    },
  },
  {
    name: 'no metadata returns empty source context',
    run: () => {
      const ctx = deriveSourceContext({ tabId: -1, frameId: -1, url: 'https://r/' }, new Map());
      assert.equal(ctx.host, '');
      assert.equal(ctx.url, '');
    },
  },
  {
    name: 'evaluateRequest: main_frame returns null when no strip rule configured',
    run: async () => {
      const result = await evaluateRequest({ type: 'main_frame', url: 'https://x/', tabId: -1, frameId: -1 }, baseDeps());
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: main_frame evaluates when strip rule present',
    run: async () => {
      const stripConfig = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{
          enabled: true,
          action: 'block',
          strip_referrer: true,
          source: { type: 'domain', regex: '(^|\\.)mybank\\.com$' },
          destination: { type: 'any' },
        }],
      };
      const result = await evaluateRequest({
        type: 'main_frame',
        url: 'https://evil.example/landing',
        tabId: -1, frameId: -1,
        documentUrl: 'https://mybank.com/account',
      }, baseDeps({ config: stripConfig }));
      assert.equal(result.verdict, 'block');
      assert.equal(result.matchedRule.index, 0);
    },
  },
  {
    name: 'evaluateRequest: main_frame stays exempt when no rule has strip flag',
    run: async () => {
      const blockConfig = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{
          enabled: true,
          action: 'block',
          strip_referrer: false,
          source: { type: 'domain', regex: '(^|\\.)mybank\\.com$' },
          destination: { type: 'any' },
        }],
      };
      const result = await evaluateRequest({
        type: 'main_frame',
        url: 'https://evil.example/landing',
        tabId: -1, frameId: -1,
        documentUrl: 'https://mybank.com/account',
      }, baseDeps({ config: blockConfig }));
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: csp_report stays exempt even with strip rule',
    run: async () => {
      const stripConfig = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{
          enabled: true,
          action: 'block',
          strip_referrer: true,
          source: { type: 'any' },
          destination: { type: 'any' },
        }],
      };
      const result = await evaluateRequest({ type: 'csp_report', url: 'https://x/', tabId: -1, frameId: -1 }, baseDeps({ config: stripConfig }));
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: self-origin returns null',
    run: async () => {
      const result = await evaluateRequest({
        type: 'xmlhttprequest', url: 'https://x/', tabId: -1, frameId: -1,
        originUrl: 'moz-extension://abc/options.html',
      }, baseDeps());
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: non-URL request returns null',
    run: async () => {
      const result = await evaluateRequest({ type: 'image', url: 'about:blank', tabId: -1, frameId: -1 }, baseDeps());
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: multi-IP geoip block hits when any matches',
    run: async () => {
      const dnsLookup = async host => host === 'cdn.x' ? [parseIp('8.8.8.8'), parseIp('1.1.1.1')] : [];
      const result = await evaluateRequest({
        type: 'image', url: 'https://cdn.x/img.png', tabId: -1, frameId: -1,
        documentUrl: 'https://owner.example/p',
      }, baseDeps({ config: blockGeoipCnConfig, dnsLookup }));
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'evaluateRequest: literal IP host skips DNS',
    run: async () => {
      let calls = 0;
      const dnsLookup = async () => { calls += 1; return []; };
      const result = await evaluateRequest({
        type: 'image', url: 'https://1.1.1.1/x', tabId: -1, frameId: -1,
      }, baseDeps({ config: blockGeoipCnConfig, dnsLookup }));
      assert.equal(result.verdict, 'block');
      assert.equal(calls, 0);
    },
  },
  {
    name: 'evaluateRequest: match_strategy=first checks only first IP',
    run: async () => {
      const config = { ...blockGeoipCnConfig, dns: { match_strategy: 'first' } };
      const dnsLookup = async () => [parseIp('8.8.8.8'), parseIp('1.1.1.1')];
      const result = await evaluateRequest({
        type: 'image', url: 'https://cdn.x/img.png', tabId: -1, frameId: -1,
      }, baseDeps({ config, dnsLookup }));
      assert.equal(result.verdict, 'allow');
    },
  },
  {
    name: 'evaluateRequest: geosite-only config skips DNS',
    run: async () => {
      let calls = 0;
      const dnsLookup = async () => { calls += 1; return [parseIp('1.1.1.1')]; };
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{
          enabled: true,
          source: { type: 'any' },
          destination: { type: 'domain', regex: 'cdn' },
          action: 'block',
        }],
      };
      const result = await evaluateRequest({
        type: 'image', url: 'https://cdn.x/img.png', tabId: -1, frameId: -1,
        documentUrl: 'https://owner.example/p',
      }, baseDeps({ config, dnsLookup }));
      assert.equal(result.verdict, 'block');
      assert.equal(calls, 0);
    },
  },
  {
    name: 'evaluateRequest: awaits whenReady before evaluating',
    run: async () => {
      const events = [];
      let release;
      const ready = new Promise(r => { release = r; });
      const geoLazy = {
        inGeoipTag(ip, tag) { events.push('inGeoipTag'); return ip.bytes[0] === 1 && tag === 'cn'; },
        inGeositeTag() { return false; },
      };
      const dnsLookup = async () => { events.push('dns'); return [parseIp('1.1.1.1')]; };
      const whenReady = () => { events.push('whenReady-call'); return ready.then(() => events.push('whenReady-resolved')); };
      const promise = evaluateRequest({
        type: 'image', url: 'https://cdn.x/img.png', tabId: -1, frameId: -1,
      }, baseDeps({ config: blockGeoipCnConfig, geo: geoLazy, dnsLookup, whenReady }));
      await new Promise(r => setTimeout(r, 10));
      assert.ok(!events.includes('inGeoipTag'), 'evaluation must not run before whenReady resolves');
      release();
      const result = await promise;
      assert.equal(result.verdict, 'block');
      assert.ok(events.indexOf('whenReady-resolved') < events.indexOf('inGeoipTag'));
    },
  },
  {
    name: 'evaluateRequest: same-host destination skips rule evaluation',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const frames = framesWith(7, 0, { host: 'ifconfig.co', url: 'https://ifconfig.co/', parentFrameId: -1 });
      const result = await evaluateRequest({
        type: 'image', url: 'https://ifconfig.co/favicon.ico', tabId: 7, frameId: 0,
      }, baseDeps({ config, frames }));
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: subdomain of source is treated as same-site',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const frames = framesWith(7, 0, { host: 'example.com', url: 'https://example.com/', parentFrameId: -1 });
      const result = await evaluateRequest({
        type: 'image', url: 'https://cdn.example.com/img.png', tabId: 7, frameId: 0,
      }, baseDeps({ config, frames }));
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: source subdomain of destination is same-site',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const frames = framesWith(7, 0, { host: 'app.example.com', url: 'https://app.example.com/', parentFrameId: -1 });
      const result = await evaluateRequest({
        type: 'image', url: 'https://example.com/img.png', tabId: 7, frameId: 0,
      }, baseDeps({ config, frames }));
      assert.equal(result, null);
    },
  },
  {
    name: 'evaluateRequest: cross-site request still evaluated',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const frames = framesWith(7, 0, { host: 'example.com', url: 'https://example.com/', parentFrameId: -1 });
      const result = await evaluateRequest({
        type: 'image', url: 'https://tracker.com/pixel.gif', tabId: 7, frameId: 0,
      }, baseDeps({ config, frames }));
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'evaluateRequest: empty source host falls through to evaluation',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const result = await evaluateRequest({
        type: 'image', url: 'https://example.com/img.png', tabId: -1, frameId: -1,
      }, baseDeps({ config }));
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'evaluateRequest: partial-suffix host is not same-site',
    run: async () => {
      const config = {
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, source: { type: 'any' }, destination: { type: 'any' }, action: 'block' }],
      };
      const frames = framesWith(7, 0, { host: 'example.com', url: 'https://example.com/', parentFrameId: -1 });
      const result = await evaluateRequest({
        type: 'image', url: 'https://otherexample.com/img.png', tabId: 7, frameId: 0,
      }, baseDeps({ config, frames }));
      assert.equal(result.verdict, 'block');
    },
  },
  {
    name: 'verdict cache: put then take returns the same result and removes from cache',
    run: () => {
      const result = { verdict: 'block', matchedRule: { index: 0, name: 'r' } };
      cachePutVerdict('req-1', result);
      const taken = cacheTakeVerdict('req-1');
      assert.equal(taken, result);
      assert.equal(cacheTakeVerdict('req-1'), undefined);
    },
  },
  {
    name: 'verdict cache: take returns undefined for unknown requestId',
    run: () => {
      assert.equal(cacheTakeVerdict('does-not-exist'), undefined);
    },
  },
  {
    name: 'verdict cache: null/undefined requestId is a no-op',
    run: () => {
      const before = _verdictCacheSize();
      cachePutVerdict(null, { verdict: 'allow' });
      cachePutVerdict(undefined, { verdict: 'allow' });
      assert.equal(_verdictCacheSize(), before);
      assert.equal(cacheTakeVerdict(null), undefined);
      assert.equal(cacheTakeVerdict(undefined), undefined);
    },
  },
  {
    name: 'verdict cache: oldest entry evicted when full',
    run: () => {
      for (let i = 0; i < 200; i++) cacheTakeVerdict(`drain-${i}`);
      for (let i = 0; i < 100; i++) cachePutVerdict(`r-${i}`, { verdict: 'allow', n: i });
      assert.equal(_verdictCacheSize(), 100);
      cachePutVerdict('r-100', { verdict: 'allow', n: 100 });
      assert.equal(_verdictCacheSize(), 100);
      assert.equal(cacheTakeVerdict('r-0'), undefined, 'oldest entry evicted');
      assert.ok(cacheTakeVerdict('r-100'), 'newest entry retained');
    },
  },
  {
    name: 'verdict cache: take returns undefined for ids that were never cached',
    run: () => {
      assert.equal(cacheTakeVerdict('phantom-id'), undefined);
    },
  },
  {
    name: 'ready gate: starts unready and becomes ready exactly once on markReady',
    run: () => {
      assert.equal(_isReady(), false, 'enforcer must start in unready state');
      markReady();
      assert.equal(_isReady(), true);
      markReady();
      assert.equal(_isReady(), true);
    },
  },
  {
    name: 'setConfig: clears verdict cache so stale entries from prior rules cannot leak',
    run: () => {
      cachePutVerdict('stale-1', { verdict: 'block' });
      cachePutVerdict('stale-2', { verdict: 'block' });
      assert.ok(_verdictCacheSize() >= 2);
      setConfig({ default_action: 'allow', rules: [] });
      assert.equal(_verdictCacheSize(), 0);
      assert.equal(cacheTakeVerdict('stale-1'), undefined);
    },
  },
  {
    name: 'setConfig: strip rule flag is true when an enabled block rule sets strip_referrer',
    run: () => {
      setConfig({
        default_action: 'allow',
        rules: [{ enabled: true, action: 'block', strip_referrer: true,
          source: { type: 'any' }, destination: { type: 'any' } }],
      });
      assert.equal(_hasStripRule(), true);
    },
  },
  {
    name: 'setConfig: strip rule flag is false when no rule has the flag',
    run: () => {
      setConfig({
        default_action: 'allow',
        rules: [{ enabled: true, action: 'block',
          source: { type: 'any' }, destination: { type: 'any' } }],
      });
      assert.equal(_hasStripRule(), false);
    },
  },
  {
    name: 'setConfig: strip rule flag false when rule with flag is disabled',
    run: () => {
      setConfig({
        default_action: 'allow',
        rules: [{ enabled: false, action: 'block', strip_referrer: true,
          source: { type: 'any' }, destination: { type: 'any' } }],
      });
      assert.equal(_hasStripRule(), false);
    },
  },
  {
    name: 'setConfig: strip rule flag false when rule with flag has action: allow',
    run: () => {
      setConfig({
        default_action: 'allow',
        rules: [{ enabled: true, action: 'allow', strip_referrer: true,
          source: { type: 'any' }, destination: { type: 'any' } }],
      });
      assert.equal(_hasStripRule(), false);
    },
  },
  {
    name: 'probe: returns verdict + trace + contexts for plain inputs',
    run: async () => {
      setConfig({
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, action: 'block',
          source: { type: 'any' },
          destination: { type: 'domain', regex: '\\.example$' } }],
      });
      const result = await probe({
        sourceUrl: 'https://a.test/',
        destinationUrl: 'https://b.example/',
      });
      assert.equal(result.verdict, 'block');
      assert.equal(result.contexts.source.host, 'a.test');
      assert.equal(result.contexts.destination.host, 'b.example');
      assert.ok(Array.isArray(result.trace));
    },
  },
  {
    name: 'probe: destinationIp override is parsed and used',
    run: async () => {
      setConfig({
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, action: 'block',
          source: { type: 'any' },
          destination: { type: 'ip', cidr: '1.2.3.0/24' } }],
      });
      const result = await probe({
        sourceUrl: 'https://a.test/',
        destinationUrl: 'https://b.test/',
        destinationIp: '1.2.3.4',
      });
      assert.equal(result.verdict, 'block');
      assert.deepEqual(result.contexts.destination.ips, ['1.2.3.4']);
    },
  },
  {
    name: 'probe: invalid destinationIp is silently dropped',
    run: async () => {
      setConfig({
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, action: 'block',
          source: { type: 'any' },
          destination: { type: 'ip', cidr: '1.2.3.0/24' } }],
      });
      const result = await probe({
        sourceUrl: 'https://a.test/',
        destinationUrl: 'https://b.test/',
        destinationIp: 'not-an-ip',
      });
      assert.equal(result.verdict, 'allow');
      assert.deepEqual(result.contexts.destination.ips, []);
    },
  },
  {
    name: 'probe: bare host without scheme is normalized',
    run: async () => {
      setConfig({
        default_action: 'allow',
        dns: { match_strategy: 'all' },
        rules: [{ enabled: true, action: 'block',
          source: { type: 'any' },
          destination: { type: 'domain', regex: '^cdn\\.test$' } }],
      });
      const result = await probe({ sourceUrl: 'a.test', destinationUrl: 'cdn.test' });
      assert.equal(result.contexts.destination.host, 'cdn.test');
      assert.equal(result.verdict, 'block');
    },
  },
];
