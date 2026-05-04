import { strict as assert } from 'node:assert';
import {
  FlatIpRadixBuilder,
  FlatDomainSuffixTreeBuilder,
} from '../lib/flat-trie.js';
import { parseIp, parseCidr } from '../lib/ip.js';

function buildIpRadix(cidrs) {
  const b = new FlatIpRadixBuilder();
  for (const text of cidrs) {
    const c = parseCidr(text);
    b.add(c.family, c.bytes, c.prefix);
  }
  return b.finish();
}

function setEqual(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

export const tests = [
  {
    name: 'flat ip radix builder: matches inside prefix',
    run: () => {
      const r = buildIpRadix(['10.0.0.0/8', '10.5.0.0/16']);
      assert.equal(r.contains(4, parseIp('10.5.5.5').bytes), true);
      assert.equal(r.contains(4, parseIp('10.6.5.5').bytes), true);
    },
  },
  {
    name: 'flat ip radix builder: v6',
    run: () => {
      const r = buildIpRadix(['2001:db8::/32']);
      assert.equal(r.contains(6, parseIp('2001:db8::1').bytes), true);
      assert.equal(r.contains(6, parseIp('2001:db9::1').bytes), false);
    },
  },
  {
    name: 'flat ip radix builder: empty',
    run: () => {
      const r = new FlatIpRadixBuilder().finish();
      assert.equal(r.contains(4, parseIp('1.1.1.1').bytes), false);
      assert.equal(r.contains(6, parseIp('::1').bytes), false);
    },
  },
  {
    name: 'flat ip radix builder: /0 matches everything',
    run: () => {
      const r = buildIpRadix(['0.0.0.0/0']);
      assert.equal(r.contains(4, parseIp('1.2.3.4').bytes), true);
      assert.equal(r.contains(4, parseIp('255.255.255.255').bytes), true);
    },
  },
  {
    name: 'flat ip radix builder: host route /32',
    run: () => {
      const r = buildIpRadix(['8.8.8.8/32']);
      assert.equal(r.contains(4, parseIp('8.8.8.8').bytes), true);
      assert.equal(r.contains(4, parseIp('8.8.8.9').bytes), false);
    },
  },
  {
    name: 'flat domain suffix tree builder: full and suffix',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addFull('exact.example.com', 1);
      b.addSuffix('search.example', 2);
      const t = b.finish();
      setEqual(t.lookup('exact.example.com'), [1]);
      setEqual(t.lookup('mail.search.example'), [2]);
      setEqual(t.lookup('search.example'), [2]);
      setEqual(t.lookup('not-exact.example.com'), []);
    },
  },
  {
    name: 'flat domain suffix tree builder: plain substring',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addPlain('shop', 5);
      const t = b.finish();
      setEqual(t.lookup('www.shop.example'), [5]);
      setEqual(t.lookup('not-relevant.example'), []);
    },
  },
  {
    name: 'flat domain suffix tree builder: regex',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addRegex('^.*\\.static\\.example$', 9);
      const t = b.finish();
      setEqual(t.lookup('cdn.static.example'), [9]);
      setEqual(t.lookup('cdn.static.test'), []);
    },
  },
  {
    name: 'flat domain suffix tree builder: invalid regex never matches',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addRegex('[', 1);
      b.addRegex('valid', 2);
      const t = b.finish();
      setEqual(t.lookup('any.host'), []);
      setEqual(t.lookup('valid'), [2]);
    },
  },
  {
    name: 'flat domain suffix tree builder: multiple entryIds per key',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addSuffix('search.example', 1);
      b.addSuffix('search.example', 2);
      const t = b.finish();
      setEqual(t.lookup('mail.search.example'), [1, 2]);
    },
  },
];
