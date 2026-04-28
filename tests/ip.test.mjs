import { strict as assert } from 'node:assert';
import { parseIp, parseCidr, ipInCidr, ipToString } from '../lib/ip.js';

export const tests = [
  {
    name: 'parses ipv4',
    run: () => {
      const ip = parseIp('192.168.1.1');
      assert.equal(ip.family, 4);
      assert.deepEqual([...ip.bytes], [192, 168, 1, 1]);
    },
  },
  {
    name: 'rejects invalid ipv4 octets',
    run: () => {
      assert.equal(parseIp('256.0.0.1'), null);
      assert.equal(parseIp('1.2.3'), null);
      assert.equal(parseIp(''), null);
    },
  },
  {
    name: 'parses ipv6 with ::',
    run: () => {
      const ip = parseIp('2001:db8::1');
      assert.equal(ip.family, 6);
      assert.equal(ip.bytes.length, 16);
      assert.equal(ip.bytes[0], 0x20);
      assert.equal(ip.bytes[1], 0x01);
      assert.equal(ip.bytes[15], 1);
    },
  },
  {
    name: 'parses ipv4-mapped ipv6',
    run: () => {
      const ip = parseIp('::ffff:192.0.2.1');
      assert.equal(ip.family, 6);
      assert.equal(ip.bytes[10], 0xff);
      assert.equal(ip.bytes[11], 0xff);
      assert.equal(ip.bytes[12], 192);
      assert.equal(ip.bytes[15], 1);
    },
  },
  {
    name: 'parses cidr',
    run: () => {
      const cidr = parseCidr('10.0.0.0/8');
      assert.equal(cidr.prefix, 8);
      assert.equal(cidr.family, 4);
    },
  },
  {
    name: 'rejects bad prefix',
    run: () => {
      assert.equal(parseCidr('10.0.0.0/33'), null);
      assert.equal(parseCidr('::/129'), null);
    },
  },
  {
    name: 'ipInCidr matches inside',
    run: () => {
      const cidr = parseCidr('10.0.0.0/8');
      const ip = parseIp('10.255.1.1');
      assert.equal(ipInCidr(ip.bytes, cidr.bytes, cidr.prefix), true);
    },
  },
  {
    name: 'ipInCidr handles non-byte prefixes',
    run: () => {
      const cidr = parseCidr('192.168.1.0/28');
      assert.equal(ipInCidr(parseIp('192.168.1.5').bytes, cidr.bytes, cidr.prefix), true);
      assert.equal(ipInCidr(parseIp('192.168.1.16').bytes, cidr.bytes, cidr.prefix), false);
    },
  },
  {
    name: 'ipv6 cidr',
    run: () => {
      const cidr = parseCidr('2001:db8::/32');
      assert.equal(ipInCidr(parseIp('2001:db8:dead::1').bytes, cidr.bytes, cidr.prefix), true);
      assert.equal(ipInCidr(parseIp('2001:dead::1').bytes, cidr.bytes, cidr.prefix), false);
    },
  },
  {
    name: 'ipToString roundtrips',
    run: () => {
      assert.equal(ipToString(4, parseIp('1.2.3.4').bytes), '1.2.3.4');
      const v6 = parseIp('2001:db8::1');
      assert.equal(ipToString(6, v6.bytes), '2001:db8::1');
    },
  },
];
