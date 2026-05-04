import { strict as assert } from 'node:assert';

const { migrate } = await import('../worker/config/migrations.js');

export const tests = [
  {
    name: 'migrate: v1 website/resource renamed to source/destination',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          website: { kind: 'domain', regex: 'foo' },
          resource: { kind: 'any' },
        }],
      });
      assert.equal(config.version, 2);
      assert.deepEqual(config.rules[0].source, { type: 'domain', regex: 'foo' });
      assert.deepEqual(config.rules[0].destination, { type: 'any' });
      assert.equal('website' in config.rules[0], false);
      assert.equal('resource' in config.rules[0], false);
    },
  },
  {
    name: 'migrate: v1 strip_referrer_on_navigation renamed to strip_referrer',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          strip_referrer_on_navigation: true,
          website: { kind: 'any' },
          resource: { kind: 'any' },
        }],
      });
      assert.equal(config.rules[0].strip_referrer, true);
      assert.equal('strip_referrer_on_navigation' in config.rules[0], false);
    },
  },
  {
    name: 'migrate: v1 matcher kind field renamed to type',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          website: { kind: 'domain', regex: 'foo' },
          resource: { kind: 'any' },
        }],
      });
      const src = config.rules[0].source;
      assert.equal(src.type, 'domain');
      assert.equal('kind' in src, false);
    },
  },
  {
    name: 'migrate: nested composite matcher terms renamed recursively',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          website: {
            kind: 'any_of',
            terms: [
              { kind: 'all_of', terms: [{ kind: 'any' }] },
              { kind: 'not', term: { kind: 'all_of', terms: [{ kind: 'any' }] } },
            ],
          },
          resource: { kind: 'any' },
        }],
      });
      const src = config.rules[0].source;
      assert.equal(src.type, 'or');
      assert.equal(src.matches[0].type, 'and');
      assert.equal(src.matches[1].type, 'not');
      assert.equal(src.matches[1].match.type, 'and');
    },
  },
  {
    name: 'migrate: v1 terms/term body fields renamed to matches/match',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          website: {
            kind: 'and',
            terms: [
              { kind: 'any' },
              { kind: 'not', term: { kind: 'any' } },
            ],
          },
          resource: { kind: 'any' },
        }],
      });
      const src = config.rules[0].source;
      assert.equal('terms' in src, false);
      assert.deepEqual(src.matches[0], { type: 'any' });
      assert.equal(src.matches[1].type, 'not');
      assert.equal('term' in src.matches[1], false);
      assert.deepEqual(src.matches[1].match, { type: 'any' });
    },
  },
  {
    name: 'migrate: isolate match matcher types renamed',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          mode: 'isolate',
          action: 'block',
          match: { kind: 'all_of', terms: [{ kind: 'any' }] },
        }],
      });
      assert.equal(config.rules[0].match.type, 'and');
    },
  },
  {
    name: 'migrate: strip_referrer wins when both legacy and modern present',
    run: () => {
      const { config } = migrate({
        version: 1,
        rules: [{
          enabled: true,
          action: 'block',
          strip_referrer_on_navigation: true,
          strip_referrer: false,
          website: { kind: 'any' },
          resource: { kind: 'any' },
        }],
      });
      assert.equal(config.rules[0].strip_referrer, false);
      assert.equal('strip_referrer_on_navigation' in config.rules[0], false);
    },
  },
  {
    name: 'migrate: v2 input is a no-op',
    run: () => {
      const { config } = migrate({
        version: 2,
        default_action: 'allow',
        rules: [{ enabled: true, action: 'block', source: { type: 'any' }, destination: { type: 'any' } }],
      });
      assert.equal(config.version, 2);
      assert.deepEqual(config.rules[0].source, { type: 'any' });
    },
  },
];
