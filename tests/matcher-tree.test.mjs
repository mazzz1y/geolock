import { strict as assert } from 'node:assert';
import { normalizeMatcher, serializeMatcher, convertType } from '../data/options/matcher-tree.js';
import { validateConfig, defaultConfig } from '../worker/config.js';

function roundtrip(matcher) {
  return serializeMatcher(normalizeMatcher(matcher));
}

export const tests = [
  {
    name: 'leaf any roundtrip',
    run: () => {
      assert.deepEqual(roundtrip({ type: 'any' }), { type: 'any' });
    },
  },
  {
    name: 'leaf geosite with attr roundtrip',
    run: () => {
      assert.deepEqual(
        roundtrip({ type: 'geosite', tag: 'GOOGLE', attr: 'ads' }),
        { type: 'geosite', tag: 'GOOGLE', attr: 'ads' },
      );
    },
  },
  {
    name: 'leaf url roundtrip',
    run: () => {
      assert.deepEqual(
        roundtrip({ type: 'url', regex: '^https://example\\.com/api/' }),
        { type: 'url', regex: '^https://example\\.com/api/' },
      );
    },
  },
  {
    name: 'and populates children from matches',
    run: () => {
      const node = normalizeMatcher({
        type: 'and',
        matches: [{ type: 'geosite', tag: 'CN' }, { type: 'geoip', tag: 'CN' }],
      });
      assert.equal(node.type, 'and');
      assert.equal(node.children.length, 2);
      assert.equal(node.children[0].type, 'geosite');
      assert.equal(node.children[1].type, 'geoip');
    },
  },
  {
    name: 'not populates one child from match',
    run: () => {
      const node = normalizeMatcher({
        type: 'not',
        match: { type: 'domain', regex: 'foo' },
      });
      assert.equal(node.type, 'not');
      assert.equal(node.children.length, 1);
      assert.equal(node.children[0].type, 'domain');
    },
  },
  {
    name: 'convertType leaf -> not wraps as child',
    run: () => {
      const node = normalizeMatcher({ type: 'geosite', tag: 'A' });
      const next = convertType(node, 'not');
      assert.equal(next.type, 'not');
      assert.equal(next.children.length, 1);
      assert.equal(next.children[0].type, 'geosite');
      assert.equal(next.children[0].tag, 'A');
    },
  },
  {
    name: 'convertType leaf -> and wraps as matches[0]',
    run: () => {
      const node = normalizeMatcher({ type: 'geoip', tag: 'CN' });
      const next = convertType(node, 'and');
      assert.equal(next.type, 'and');
      assert.equal(next.children.length, 1);
      assert.equal(next.children[0].type, 'geoip');
    },
  },
  {
    name: 'convertType and -> or preserves children',
    run: () => {
      const node = normalizeMatcher({
        type: 'and',
        matches: [{ type: 'geosite', tag: 'A' }, { type: 'geoip', tag: 'B' }],
      });
      const next = convertType(node, 'or');
      assert.equal(next.type, 'or');
      assert.equal(next.children.length, 2);
      assert.equal(next.children[0].type, 'geosite');
    },
  },
  {
    name: 'convertType composite -> leaf drops children silently',
    run: () => {
      const node = normalizeMatcher({
        type: 'and',
        matches: [{ type: 'geosite', tag: 'A' }],
      });
      const next = convertType(node, 'any');
      assert.equal(next.type, 'any');
      assert.equal(next.children.length, 0);
    },
  },
  {
    name: 'convertType to advanced serializes',
    run: () => {
      const node = normalizeMatcher({
        type: 'and',
        matches: [{ type: 'geosite', tag: 'A' }],
      });
      const next = convertType(node, '__advanced__');
      assert.equal(next.type, '__advanced__');
      const parsed = JSON.parse(next.json);
      assert.equal(parsed.type, 'and');
      assert.equal(parsed.matches[0].tag, 'A');
    },
  },
  {
    name: 'convertType from advanced with bad JSON falls back to leaf',
    run: () => {
      const advanced = { type: '__advanced__', json: 'not json', children: [] };
      const next = convertType(advanced, 'any');
      assert.equal(next.type, 'any');
    },
  },
  {
    name: 'convertType from advanced with valid JSON normalizes',
    run: () => {
      const advanced = {
        type: '__advanced__',
        json: JSON.stringify({ type: 'geosite', tag: 'X' }),
        children: [],
      };
      const next = convertType(advanced, 'geosite');
      assert.equal(next.type, 'geosite');
      assert.equal(next.tag, 'X');
    },
  },
  {
    name: 'convertType leaf -> and does not create circular reference',
    run: () => {
      const node = normalizeMatcher({ type: 'geosite', tag: 'A' });
      const next = convertType(node, 'and');
      assert.notEqual(next.children[0], node);
      assert.equal(next.children[0].type, 'geosite');
      assert.equal(next.children[0].tag, 'A');
    },
  },
  {
    name: 'deep tree validates against config schema',
    run: () => {
      const tree = {
        type: 'and',
        matches: [
          {
            type: 'or',
            matches: [
              { type: 'geosite', tag: 'GOOGLE' },
              { type: 'geoip', tag: 'US' },
            ],
          },
          { type: 'not', match: { type: 'domain', regex: 'safe' } },
        ],
      };
      const node = normalizeMatcher(tree);
      const serialized = serializeMatcher(node);

      const config = defaultConfig();
      config.rules.push({
        name: 'deep',
        enabled: true,
        action: 'block',
        strip_referrer: false,
        bidirectional: false,
        source: { type: 'any' },
        destination: serialized,
      });
      const validation = validateConfig(config);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    },
  },
];
