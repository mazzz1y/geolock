import { Reader, WIRE_LENGTH_DELIMITED } from '../../lib/protobuf-mini.js';
import { FlatIpRadixBuilder, FlatDomainSuffixTreeBuilder } from '../../lib/flat-trie.js';

const DOMAIN_TYPE_PLAIN = 0;
const DOMAIN_TYPE_REGEX = 1;
const DOMAIN_TYPE_DOMAIN = 2;
const DOMAIN_TYPE_FULL = 3;

export function scanCatalog(bytes) {
  const catalog = new Map();
  const reader = new Reader(bytes);
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field !== 1 || tag.wireType !== WIRE_LENGTH_DELIMITED) {
      reader.skip(tag.wireType);
      continue;
    }
    const length = reader.readVarintNumber();
    const offset = reader.offset;
    if (offset + length > reader.end) throw new Error('protobuf: ld past end');
    const slice = bytes.subarray(offset, offset + length);
    const tagName = readEntryTagName(slice);
    if (tagName) {
      catalog.set(tagName, { offset, length, count: countField(slice, 2) });
    }
    reader.offset += length;
  }
  return catalog;
}

export function buildGeoipTagTrie(slice) {
  const cidrs = readGeoipCidrs(slice);
  const builder = new FlatIpRadixBuilder();
  for (const cidr of cidrs) {
    builder.add(cidr.ip.length === 4 ? 4 : 6, cidr.ip, cidr.prefix);
  }
  return { trie: builder.finish(), count: cidrs.length };
}

export function buildGeositeTagTrie(slice) {
  const domains = readGeositeDomains(slice);
  const builder = new FlatDomainSuffixTreeBuilder();
  const attrs = [];
  for (const domain of domains) {
    const entryId = attrs.length;
    attrs.push(domain.attrs);
    if (domain.type === DOMAIN_TYPE_FULL) builder.addFull(domain.value, entryId);
    else if (domain.type === DOMAIN_TYPE_DOMAIN) builder.addSuffix(domain.value, entryId);
    else if (domain.type === DOMAIN_TYPE_PLAIN) builder.addPlain(domain.value, entryId);
    else if (domain.type === DOMAIN_TYPE_REGEX) builder.addRegex(domain.value, entryId);
  }
  return { trie: builder.finish(), attrs, count: domains.length };
}

function readEntryTagName(slice) {
  const reader = new Reader(slice);
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      return reader.readString().toLowerCase();
    }
    reader.skip(tag.wireType);
  }
  return '';
}

function countField(slice, targetField) {
  const reader = new Reader(slice);
  let count = 0;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === targetField) count += 1;
    reader.skip(tag.wireType);
  }
  return count;
}

function readGeoipCidrs(slice) {
  const reader = new Reader(slice);
  const cidrs = [];
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      const cidr = readCidr(reader.readLengthDelimited());
      if (cidr) cidrs.push(cidr);
    } else {
      reader.skip(tag.wireType);
    }
  }
  return cidrs;
}

function readGeositeDomains(slice) {
  const reader = new Reader(slice);
  const domains = [];
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      const domain = readDomain(reader.readLengthDelimited());
      if (domain) domains.push(domain);
    } else {
      reader.skip(tag.wireType);
    }
  }
  return domains;
}

function readCidr(bytes) {
  const reader = new Reader(bytes);
  let ip = null;
  let prefix = 0;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      ip = reader.readLengthDelimited();
    } else if (tag.field === 2) {
      prefix = reader.readVarintNumber();
    } else {
      reader.skip(tag.wireType);
    }
  }
  if (!ip || (ip.length !== 4 && ip.length !== 16)) return null;
  const max = ip.length === 4 ? 32 : 128;
  if (prefix < 0 || prefix > max) return null;
  return { ip: new Uint8Array(ip), prefix };
}

function readDomain(bytes) {
  const reader = new Reader(bytes);
  let type = DOMAIN_TYPE_PLAIN;
  let value = '';
  const attrs = [];
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      type = reader.readVarintNumber();
    } else if (tag.field === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      value = reader.readString();
    } else if (tag.field === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      const key = readAttributeKey(reader.readLengthDelimited());
      if (key) attrs.push(key);
    } else {
      reader.skip(tag.wireType);
    }
  }
  return value ? { type, value, attrs } : null;
}

function readAttributeKey(bytes) {
  const reader = new Reader(bytes);
  let key = '';
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      key = reader.readString();
    } else {
      reader.skip(tag.wireType);
    }
  }
  return key.toLowerCase();
}
