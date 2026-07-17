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
    name: 'strips brackets from ipv6 literals',
    run: () => {
      const ip = parseIp('[::1]');
      assert.equal(ip.family, 6);
      assert.equal(ip.bytes[15], 1);
      const full = parseIp('[2001:db8::2]');
      assert.equal(full.family, 6);
      assert.equal(full.bytes[0], 0x20);
      assert.equal(parseIp('[1.2.3.4]'), null);
      assert.equal(parseIp('[::1'), null);
    },
  },
  {
    name: 'normalizes ipv4-mapped ipv6 to family 4',
    run: () => {
      const ip = parseIp('::ffff:192.0.2.1');
      assert.equal(ip.family, 4);
      assert.deepEqual([...ip.bytes], [192, 0, 2, 1]);
      const hex = parseIp('::ffff:c000:201');
      assert.equal(hex.family, 4);
      assert.deepEqual([...hex.bytes], [192, 0, 2, 1]);
      const cidr = parseCidr('192.0.2.0/24');
      assert.equal(ipInCidr(ip.bytes, cidr.bytes, cidr.prefix), true);
    },
  },
  {
    name: 'non-mapped ::ffff-like addresses stay family 6',
    run: () => {
      assert.equal(parseIp('1::ffff:1.2.3.4').family, 6);
      assert.equal(parseIp('::fffe:1.2.3.4').family, 6);
    },
  },
  {
    name: 'rejects invalid ipv6 shapes',
    run: () => {
      assert.equal(parseIp('1::2::3'), null);
      assert.equal(parseIp(':::'), null);
      assert.equal(parseIp(':1:2:3:4:5:6:7'), null);
      assert.equal(parseIp('1:2:3:4:5:6:7:'), null);
      assert.equal(parseIp(':1::2'), null);
      assert.equal(parseIp('1::2:'), null);
      assert.equal(parseIp('1:2:3:4:5:6:7'), null);
    },
  },
  {
    name: 'accepts full 8-group ipv6 without ::',
    run: () => {
      const ip = parseIp('2001:0db8:0000:0000:0000:0000:0000:0001');
      assert.equal(ip.family, 6);
      assert.equal(ip.bytes[15], 1);
    },
  },
  {
    name: 'rejects leading-zero ipv4 octets',
    run: () => {
      assert.equal(parseIp('01.2.3.4'), null);
      assert.equal(parseIp('1.02.3.4'), null);
      assert.equal(parseIp('1.2.3.004'), null);
      assert.notEqual(parseIp('0.2.3.4'), null);
    },
  },
  {
    name: 'parseCidr strictly validates prefix text',
    run: () => {
      assert.equal(parseCidr('1.2.3.4/'), null);
      assert.equal(parseCidr('1.2.3.4/+8'), null);
      assert.equal(parseCidr('1.2.3.4/ 8'), null);
      assert.equal(parseCidr('1.2.3.4/8 '), null);
      assert.equal(parseCidr('1.2.3.4/8.5'), null);
      assert.equal(parseCidr('1.2.3.4/0008'), null);
      assert.equal(parseCidr('1.2.3.4/0').prefix, 0);
      assert.equal(parseCidr('::/128').prefix, 128);
    },
  },
  {
    name: 'parseCidr translates IPv4-mapped v6 prefixes',
    run: () => {
      const mappedAll = parseCidr('::ffff:0:0/96');
      assert.equal(mappedAll.family, 4);
      assert.equal(mappedAll.prefix, 0);
      const mappedNet = parseCidr('::ffff:1.2.3.0/120');
      assert.equal(mappedNet.family, 4);
      assert.equal(mappedNet.prefix, 24);
      assert.equal(ipInCidr(parseIp('1.2.3.9').bytes, mappedNet.bytes, mappedNet.prefix), true);
      assert.equal(parseCidr('::ffff:1.2.3.0/64'), null);
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
