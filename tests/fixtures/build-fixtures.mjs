import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writer } from './protobuf-writer.mjs';
import { WIRE_VARINT } from '../../lib/protobuf-mini.js';
import { parseCidr } from '../../lib/ip.js';

const here = dirname(fileURLToPath(import.meta.url));

function buildCidr(text) {
  const cidr = parseCidr(text);
  const writer = new Writer();
  writer.writeLengthDelimited(1, cidr.bytes);
  writer.writeUint32(2, cidr.prefix);
  return writer.finish();
}

function buildGeoipEntry(country, cidrTexts) {
  const writer = new Writer();
  writer.writeString(1, country);
  for (const text of cidrTexts) {
    writer.writeLengthDelimited(2, buildCidr(text));
  }
  return writer.finish();
}

function buildGeoip(entries) {
  const writer = new Writer();
  for (const entry of entries) {
    writer.writeLengthDelimited(1, buildGeoipEntry(entry.country, entry.cidrs));
  }
  return writer.finish();
}

function buildAttribute(key) {
  const writer = new Writer();
  writer.writeString(1, key);
  writer.writeTag(2, WIRE_VARINT);
  writer.writeVarint(1);
  return writer.finish();
}

function buildDomain(type, value, attrs = []) {
  const writer = new Writer();
  writer.writeTag(1, WIRE_VARINT);
  writer.writeVarint(type);
  writer.writeString(2, value);
  for (const key of attrs) {
    writer.writeLengthDelimited(3, buildAttribute(key));
  }
  return writer.finish();
}

function buildGeositeEntry(country, domains) {
  const writer = new Writer();
  writer.writeString(1, country);
  for (const d of domains) {
    writer.writeLengthDelimited(2, buildDomain(d.type, d.value, d.attrs ?? []));
  }
  return writer.finish();
}

function buildGeosite(entries) {
  const writer = new Writer();
  for (const entry of entries) {
    writer.writeLengthDelimited(1, buildGeositeEntry(entry.country, entry.domains));
  }
  return writer.finish();
}

const geoip = buildGeoip([
  { country: 'US', cidrs: ['1.0.0.0/8', '8.8.8.0/24'] },
  { country: 'CN', cidrs: ['1.1.0.0/16', '2001:db8::/32'] },
  { country: 'RU', cidrs: ['10.0.0.0/8'] },
]);

const geosite = buildGeosite([
  {
    country: 'GOOGLE',
    domains: [
      { type: 2, value: 'google.com' },
      { type: 2, value: 'youtube.com', attrs: ['ads'] },
      { type: 3, value: 'mail.google.com' },
      { type: 1, value: '^.*\\.gstatic\\.com$' },
    ],
  },
  {
    country: 'CN',
    domains: [
      { type: 2, value: 'baidu.com' },
      { type: 0, value: 'qq' },
    ],
  },
]);

await writeFile(join(here, 'tiny-geoip.dat'), Buffer.from(geoip));
await writeFile(join(here, 'tiny-geosite.dat'), Buffer.from(geosite));

console.log('built fixtures: tiny-geoip.dat, tiny-geosite.dat');
