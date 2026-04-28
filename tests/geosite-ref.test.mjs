import { strict as assert } from 'node:assert';
import { parseGeositeRef, formatGeositeRef } from '../lib/geosite-ref.js';

export const tests = [
  {
    name: 'parses tag only',
    run: () => {
      assert.deepEqual(parseGeositeRef('google'), { tag: 'google', attr: null });
    },
  },
  {
    name: 'parses tag@attr',
    run: () => {
      assert.deepEqual(parseGeositeRef('google@cn'), { tag: 'google', attr: 'cn' });
    },
  },
  {
    name: 'rejects empty parts',
    run: () => {
      assert.equal(parseGeositeRef('@cn'), null);
      assert.equal(parseGeositeRef('google@'), null);
      assert.equal(parseGeositeRef(''), null);
    },
  },
  {
    name: 'roundtrip via format',
    run: () => {
      const ref = parseGeositeRef('GOOGLE@CN');
      assert.equal(formatGeositeRef(ref), 'google@cn');
      assert.equal(formatGeositeRef({ tag: 'CN' }), 'cn');
    },
  },
];
