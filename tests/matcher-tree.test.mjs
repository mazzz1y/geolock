import { strict as assert } from 'node:assert';
import { normalizeMatcher, serializeMatcher, convertKind } from '../data/options/matcher-tree.js';
import { validateConfig, defaultConfig } from '../worker/config.js';

function roundtrip(matcher) {
  return serializeMatcher(normalizeMatcher(matcher));
}

export const tests = [
  {
    name: 'leaf any roundtrip',
    run: () => {
      assert.deepEqual(roundtrip({ kind: 'any' }), { kind: 'any' });
    },
  },
  {
    name: 'leaf geosite with attr roundtrip',
    run: () => {
      assert.deepEqual(
        roundtrip({ kind: 'geosite', tag: 'GOOGLE', attr: 'ads' }),
        { kind: 'geosite', tag: 'GOOGLE', attr: 'ads' },
      );
    },
  },
  {
    name: 'leaf url roundtrip',
    run: () => {
      assert.deepEqual(
        roundtrip({ kind: 'url', regex: '^https://example\\.com/api/' }),
        { kind: 'url', regex: '^https://example\\.com/api/' },
      );
    },
  },
  {
    name: 'all_of populates children from terms',
    run: () => {
      const node = normalizeMatcher({
        kind: 'all_of',
        terms: [{ kind: 'geosite', tag: 'CN' }, { kind: 'geoip', tag: 'CN' }],
      });
      assert.equal(node.kind, 'all_of');
      assert.equal(node.children.length, 2);
      assert.equal(node.children[0].kind, 'geosite');
      assert.equal(node.children[1].kind, 'geoip');
    },
  },
  {
    name: 'not populates one child from term',
    run: () => {
      const node = normalizeMatcher({
        kind: 'not',
        term: { kind: 'domain', regex: 'foo' },
      });
      assert.equal(node.kind, 'not');
      assert.equal(node.children.length, 1);
      assert.equal(node.children[0].kind, 'domain');
    },
  },
  {
    name: 'convertKind leaf -> not wraps as child',
    run: () => {
      const node = normalizeMatcher({ kind: 'geosite', tag: 'A' });
      const next = convertKind(node, 'not');
      assert.equal(next.kind, 'not');
      assert.equal(next.children.length, 1);
      assert.equal(next.children[0].kind, 'geosite');
      assert.equal(next.children[0].tag, 'A');
    },
  },
  {
    name: 'convertKind leaf -> all_of wraps as terms[0]',
    run: () => {
      const node = normalizeMatcher({ kind: 'geoip', tag: 'CN' });
      const next = convertKind(node, 'all_of');
      assert.equal(next.kind, 'all_of');
      assert.equal(next.children.length, 1);
      assert.equal(next.children[0].kind, 'geoip');
    },
  },
  {
    name: 'convertKind all_of -> any_of preserves children',
    run: () => {
      const node = normalizeMatcher({
        kind: 'all_of',
        terms: [{ kind: 'geosite', tag: 'A' }, { kind: 'geoip', tag: 'B' }],
      });
      const next = convertKind(node, 'any_of');
      assert.equal(next.kind, 'any_of');
      assert.equal(next.children.length, 2);
      assert.equal(next.children[0].kind, 'geosite');
    },
  },
  {
    name: 'convertKind composite -> leaf drops children silently',
    run: () => {
      const node = normalizeMatcher({
        kind: 'all_of',
        terms: [{ kind: 'geosite', tag: 'A' }],
      });
      const next = convertKind(node, 'any');
      assert.equal(next.kind, 'any');
      assert.equal(next.children.length, 0);
    },
  },
  {
    name: 'convertKind to advanced serializes',
    run: () => {
      const node = normalizeMatcher({
        kind: 'all_of',
        terms: [{ kind: 'geosite', tag: 'A' }],
      });
      const next = convertKind(node, '__advanced__');
      assert.equal(next.kind, '__advanced__');
      const parsed = JSON.parse(next.json);
      assert.equal(parsed.kind, 'all_of');
      assert.equal(parsed.terms[0].tag, 'A');
    },
  },
  {
    name: 'convertKind from advanced with bad JSON falls back to leaf',
    run: () => {
      const advanced = { kind: '__advanced__', json: 'not json', children: [] };
      const next = convertKind(advanced, 'any');
      assert.equal(next.kind, 'any');
    },
  },
  {
    name: 'convertKind from advanced with valid JSON normalizes',
    run: () => {
      const advanced = {
        kind: '__advanced__',
        json: JSON.stringify({ kind: 'geosite', tag: 'X' }),
        children: [],
      };
      const next = convertKind(advanced, 'geosite');
      assert.equal(next.kind, 'geosite');
      assert.equal(next.tag, 'X');
    },
  },
  {
    name: 'convertKind leaf -> all_of does not create circular reference',
    run: () => {
      const node = normalizeMatcher({ kind: 'geosite', tag: 'A' });
      const next = convertKind(node, 'all_of');
      assert.notEqual(next.children[0], node);
      assert.equal(next.children[0].kind, 'geosite');
      assert.equal(next.children[0].tag, 'A');
    },
  },
  {
    name: 'deep tree validates against config schema',
    run: () => {
      const tree = {
        kind: 'all_of',
        terms: [
          {
            kind: 'any_of',
            terms: [
              { kind: 'geosite', tag: 'GOOGLE' },
              { kind: 'geoip', tag: 'US' },
            ],
          },
          { kind: 'not', term: { kind: 'domain', regex: 'safe' } },
        ],
      };
      const node = normalizeMatcher(tree);
      const serialized = serializeMatcher(node);

      const config = defaultConfig();
      config.rules.push({
        id: 'r1',
        name: 'deep',
        enabled: true,
        action: 'block',
        website: { kind: 'any' },
        resource: serialized,
      });
      const validation = validateConfig(config);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    },
  },
];
