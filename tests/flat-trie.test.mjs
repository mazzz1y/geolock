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
    name: 'flat domain suffix tree: matchesAny agrees with lookup across kinds',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addFull('exact.example.com', 1);
      b.addSuffix('search.example', 2);
      b.addPlain('shop', 3);
      b.addRegex('^cdn\\.static\\.', 4);
      b.addRegex('[', 5);
      const t = b.finish();
      const hosts = [
        'exact.example.com', 'not-exact.example.com',
        'mail.search.example', 'search.example', 'notsearch.example',
        'www.shop.example', 'plain.example',
        'cdn.static.example', 'cdn.dynamic.example',
        'EXACT.EXAMPLE.COM',
      ];
      for (const host of hosts) {
        assert.equal(t.matchesAny(host), t.lookup(host).size > 0, host);
      }
    },
  },
  {
    name: 'flat domain suffix tree: matchesAny escapes plain needle metachars',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addPlain('a.b', 1);
      b.addPlain('x-y', 2);
      b.addPlain('c+d', 3);
      const t = b.finish();
      assert.equal(t.matchesAny('foo.a.b.example'), true);
      assert.equal(t.matchesAny('axb.example'), false);
      assert.equal(t.matchesAny('foo.x-y.example'), true);
      assert.equal(t.matchesAny('foo.c+d.example'), true);
      assert.equal(t.matchesAny('foo.ccd.example'), false);
      for (const host of ['foo.a.b.example', 'axb.example', 'foo.c+d.example', 'foo.ccd.example']) {
        assert.equal(t.matchesAny(host), t.lookup(host).size > 0, host);
      }
    },
  },
  {
    name: 'flat domain suffix tree: matchesAny chunks large plain sets',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      for (let i = 0; i < 1200; i += 1) b.addPlain(`needle-${i}.z`, i);
      const t = b.finish();
      assert.equal(t.matchesAny('www.needle-0.z.example'), true);
      assert.equal(t.matchesAny('www.needle-1199.z.example'), true);
      assert.equal(t.matchesAny('www.needle-1200.z.example'), false);
      assert.equal(t.plainChunks.length, 3);
    },
  },
  {
    name: 'flat domain suffix tree: strict suffix excludes the domain itself',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addStrictSuffix('example.com', 7);
      const t = b.finish();
      assert.equal(t.matchesAny('example.com'), false);
      assert.equal(t.matchesAny('a.example.com'), true);
      assert.equal(t.matchesAny('deep.a.example.com'), true);
      assert.equal(t.matchesAny('badexample.com'), false);
      setEqual(t.lookup('example.com'), []);
      setEqual(t.lookup('a.example.com'), [7]);
      setEqual(t.lookup('deep.a.example.com'), [7]);
    },
  },
  {
    name: 'flat domain suffix tree: strict and plain suffix coexist',
    run: () => {
      const b = new FlatDomainSuffixTreeBuilder();
      b.addSuffix('foo.example', 1);
      b.addStrictSuffix('bar.example', 2);
      const t = b.finish();
      assert.equal(t.matchesAny('foo.example'), true);
      assert.equal(t.matchesAny('x.foo.example'), true);
      assert.equal(t.matchesAny('bar.example'), false);
      assert.equal(t.matchesAny('x.bar.example'), true);
      setEqual(t.lookup('x.bar.example'), [2]);
      setEqual(t.lookup('bar.example'), []);
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
