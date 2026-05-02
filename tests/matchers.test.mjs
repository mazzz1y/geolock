import { strict as assert } from 'node:assert';
import { matches, andK, orK, notK, UNDECIDED } from '../worker/matchers.js';
import { parseIp } from '../lib/ip.js';

const fakeGeo = {
  inGeoipTag(ip, tag) {
    if (!ip) return false;
    if (ip.bytes[0] === 8) return tag === 'us';
    if (ip.bytes[0] === 1 && ip.bytes[1] === 1) return tag === 'cn';
    return false;
  },
  inGeositeTag(host, tag, attr) {
    if (tag !== 'google') return false;
    if (attr === 'ads') return host === 'youtube.com';
    if (attr) return false;
    return host.endsWith('google.com');
  },
};

export const tests = [
  {
    name: 'any matches anything',
    run: () => {
      assert.equal(matches({ kind: 'any' }, { host: 'x' }, fakeGeo), true);
    },
  },
  {
    name: 'geosite tag match',
    run: () => {
      assert.equal(matches({ kind: 'geosite', tag: 'google' }, { host: 'mail.google.com' }, fakeGeo), true);
      assert.equal(matches({ kind: 'geosite', tag: 'google' }, { host: 'example.com' }, fakeGeo), false);
    },
  },
  {
    name: 'geosite with attr',
    run: () => {
      assert.equal(matches({ kind: 'geosite', tag: 'google', attr: 'ads' }, { host: 'youtube.com' }, fakeGeo), true);
      assert.equal(matches({ kind: 'geosite', tag: 'google', attr: 'ads' }, { host: 'mail.google.com' }, fakeGeo), false);
    },
  },
  {
    name: 'geoip with explicit ip',
    run: () => {
      const ctx = { host: 'whatever', ips: [parseIp('8.8.8.8')] };
      assert.equal(matches({ kind: 'geoip', tag: 'us' }, ctx, fakeGeo), true);
      assert.equal(matches({ kind: 'geoip', tag: 'cn' }, ctx, fakeGeo), false);
    },
  },
  {
    name: 'geoip multi-IP: any-match hits',
    run: () => {
      const ctx = { host: 'h', ips: [parseIp('1.1.1.1'), parseIp('8.8.8.8')] };
      assert.equal(matches({ kind: 'geoip', tag: 'us' }, ctx, fakeGeo), true);
      assert.equal(matches({ kind: 'geoip', tag: 'cn' }, ctx, fakeGeo), true);
    },
  },
  {
    name: 'domain regex',
    run: () => {
      assert.equal(matches({ kind: 'domain', regex: '\\.example\\.com$' }, { host: 'foo.example.com' }, fakeGeo), true);
      assert.equal(matches({ kind: 'domain', regex: '\\.example\\.com$' }, { host: 'example.org' }, fakeGeo), false);
    },
  },
  {
    name: 'ip cidr',
    run: () => {
      const ctx = { host: 'h', ips: [parseIp('10.5.5.5')] };
      assert.equal(matches({ kind: 'ip', cidr: '10.0.0.0/8' }, ctx, fakeGeo), true);
      assert.equal(matches({ kind: 'ip', cidr: '11.0.0.0/8' }, ctx, fakeGeo), false);
    },
  },
  {
    name: 'ip cidr multi-IP: any-match hits',
    run: () => {
      const ctx = { host: 'h', ips: [parseIp('1.1.1.1'), parseIp('10.5.5.5')] };
      assert.equal(matches({ kind: 'ip', cidr: '10.0.0.0/8' }, ctx, fakeGeo), true);
    },
  },
  {
    name: 'ip cidr multi-IP: family mismatch skipped',
    run: () => {
      const ctx = { host: 'h', ips: [parseIp('::1'), parseIp('10.5.5.5')] };
      assert.equal(matches({ kind: 'ip', cidr: '10.0.0.0/8' }, ctx, fakeGeo), true);
      assert.equal(matches({ kind: 'ip', cidr: '11.0.0.0/8' }, ctx, fakeGeo), false);
    },
  },
  {
    name: 'all_of any_of not',
    run: () => {
      const m = {
        kind: 'all_of',
        terms: [
          { kind: 'any_of', terms: [{ kind: 'geosite', tag: 'google' }, { kind: 'geosite', tag: 'cn' }] },
          { kind: 'not', term: { kind: 'domain', regex: '^bad' } },
        ],
      };
      assert.equal(matches(m, { host: 'mail.google.com' }, fakeGeo), true);
      assert.equal(matches(m, { host: 'badmail.google.com' }, fakeGeo), false);
    },
  },
  {
    name: 'invalid regex never matches',
    run: () => {
      assert.equal(matches({ kind: 'domain', regex: '[' }, { host: 'x' }, fakeGeo), false);
    },
  },
  {
    name: 'url regex matches full URL',
    run: () => {
      const ctx = { host: 'example.com', url: 'https://example.com/api/v1/items?id=1' };
      assert.equal(matches({ kind: 'url', regex: '^https://example\\.com/api/' }, ctx, fakeGeo), true);
      assert.equal(matches({ kind: 'url', regex: '/admin/' }, ctx, fakeGeo), false);
    },
  },
  {
    name: 'url invalid regex never matches',
    run: () => {
      assert.equal(matches({ kind: 'url', regex: '[' }, { host: 'h', url: 'https://x/' }, fakeGeo), false);
    },
  },
  {
    name: 'tri-state: leaves return UNDECIDED when context field missing',
    run: () => {
      // empty value
      assert.equal(matches({ kind: 'geosite', tag: 'google' }, { host: '' }, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'domain', regex: 'foo' }, { host: '' }, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'url', regex: 'foo' }, { url: '' }, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'geoip', tag: 'cn' }, { ips: [] }, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'ip', cidr: '10.0.0.0/8' }, { ips: [] }, fakeGeo), UNDECIDED);
      // missing property
      assert.equal(matches({ kind: 'geosite', tag: 'google' }, {}, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'domain', regex: 'foo' }, {}, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'url', regex: 'foo' }, {}, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'geoip', tag: 'cn' }, {}, fakeGeo), UNDECIDED);
      assert.equal(matches({ kind: 'ip', cidr: '10.0.0.0/8' }, {}, fakeGeo), UNDECIDED);
    },
  },
  {
    name: 'tri-state: NOT(UNDECIDED) === UNDECIDED',
    run: () => {
      assert.equal(matches({ kind: 'not', term: { kind: 'geosite', tag: 'google' } }, { host: '' }, fakeGeo), UNDECIDED);
    },
  },
  {
    name: 'tri-state: all_of with UNDECIDED term',
    run: () => {
      const m = { kind: 'all_of', terms: [{ kind: 'geosite', tag: 'google' }, { kind: 'geoip', tag: 'cn' }] };
      assert.equal(matches(m, { host: '', ips: [parseIp('8.8.8.8')] }, fakeGeo), false);
      assert.equal(matches(m, { host: '', ips: [parseIp('1.1.1.1')] }, fakeGeo), UNDECIDED);
    },
  },
  {
    name: 'tri-state: any_of with UNDECIDED term',
    run: () => {
      const m = { kind: 'any_of', terms: [{ kind: 'geosite', tag: 'google' }, { kind: 'geoip', tag: 'cn' }] };
      assert.equal(matches(m, { host: '', ips: [parseIp('1.1.1.1')] }, fakeGeo), true);
      assert.equal(matches(m, { host: '', ips: [parseIp('8.8.8.8')] }, fakeGeo), UNDECIDED);
    },
  },
  {
    name: 'tri-state: Kleene helpers handle UNDECIDED',
    run: () => {
      assert.equal(andK(true, UNDECIDED), UNDECIDED);
      assert.equal(andK(false, UNDECIDED), false);
      assert.equal(andK(UNDECIDED, UNDECIDED), UNDECIDED);
      assert.equal(orK(true, UNDECIDED), true);
      assert.equal(orK(false, UNDECIDED), UNDECIDED);
      assert.equal(orK(UNDECIDED, UNDECIDED), UNDECIDED);
      assert.equal(notK(UNDECIDED), UNDECIDED);
    },
  },
];
