import { FlatIpRadixBuilder, FlatDomainSuffixTreeBuilder } from '../../lib/flat-trie.js';
import { parseCidr } from '../../lib/ip.js';

const MAGIC = [0x53, 0x52, 0x53];
const RULE_DEFAULT = 0;
const RULE_LOGICAL = 1;
const ITEM_FINAL = 0xff;

const ITEM_QUERY_TYPE = 0;
const ITEM_NETWORK = 1;
const ITEM_DOMAIN = 2;
const ITEM_DOMAIN_KEYWORD = 3;
const ITEM_DOMAIN_REGEX = 4;
const ITEM_SOURCE_IP_CIDR = 5;
const ITEM_IP_CIDR = 6;
const ITEM_SOURCE_PORT = 7;
const ITEM_SOURCE_PORT_RANGE = 8;
const ITEM_PORT = 9;
const ITEM_PORT_RANGE = 10;
const ITEM_ADGUARD = 16;
const ITEM_NETWORK_TYPE = 18;
const ITEM_NETWORK_IS_EXPENSIVE = 19;
const ITEM_NETWORK_IS_CONSTRAINED = 20;
const ITEM_WIFI_SSID = 21;
const ITEM_WIFI_BSSID = 22;

const STRING_LIST_ITEMS = new Set([
  ITEM_NETWORK, ITEM_DOMAIN_KEYWORD, ITEM_DOMAIN_REGEX,
  ITEM_SOURCE_PORT_RANGE, ITEM_PORT_RANGE,
  11, 12, 13, 14, 15, 17, 23,
]);

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new Error('srs: unexpected end of data');
    return this.bytes[this.offset++];
  }

  take(length) {
    if (this.offset + length > this.bytes.length) throw new Error('srs: unexpected end of data');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  uvarint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 63n) throw new Error('srs: uvarint overflow');
    }
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('srs: uvarint too large');
    return Number(result);
  }

  string() {
    const length = this.uvarint();
    return new TextDecoder().decode(this.take(length));
  }

  uint64BE() {
    const value = bytesToBigInt(this.take(8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('srs: uint64 too large');
    return Number(value);
  }

  uint64Slice() {
    const count = this.uvarint();
    if (count * 8 > this.bytes.length - this.offset) throw new Error('srs: unexpected end of data');
    const out = new BigUint64Array(count);
    for (let i = 0; i < count; i += 1) out[i] = bytesToBigInt(this.take(8));
    return out;
  }
}

function emptyParsed() {
  return { domains: [], suffixes: [], strictSuffixes: [], keywords: [], regexes: [], cidrs: [] };
}

export async function parseRuleSet(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length >= 3 && raw[0] === MAGIC[0] && raw[1] === MAGIC[1] && raw[2] === MAGIC[2]) {
    return parseBinary(raw);
  }
  return parseJsonSource(raw);
}

async function parseBinary(raw) {
  if (raw.length < 4) throw new Error('srs: file too small');
  const version = raw[3];
  if (version < 1 || version > 5) throw new Error(`srs: unsupported version ${version}`);
  const payload = await inflate(raw.subarray(4));
  const reader = new ByteReader(payload);
  const ruleCount = reader.uvarint();
  const parsed = emptyParsed();
  for (let i = 0; i < ruleCount; i += 1) {
    readRule(reader, parsed);
  }
  return parsed;
}

async function inflate(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function readRule(reader, parsed) {
  const type = reader.byte();
  if (type === RULE_LOGICAL) throw new Error('srs: logical rules are not supported');
  if (type !== RULE_DEFAULT) throw new Error(`srs: unknown rule type ${type}`);
  for (;;) {
    const item = reader.byte();
    if (item === ITEM_FINAL) break;
    readRuleItem(reader, item, parsed);
  }
  const invert = reader.byte();
  if (invert !== 0) throw new Error('srs: inverted rules are not supported');
}

function readRuleItem(reader, item, parsed) {
  switch (item) {
    case ITEM_DOMAIN:
      readDomainSet(reader, parsed);
      return;
    case ITEM_DOMAIN_KEYWORD:
      parsed.keywords.push(...readStringList(reader));
      return;
    case ITEM_DOMAIN_REGEX:
      parsed.regexes.push(...readStringList(reader));
      return;
    case ITEM_IP_CIDR:
      parsed.cidrs.push(...readIpSet(reader));
      return;
    case ITEM_SOURCE_IP_CIDR:
      readIpSet(reader);
      return;
    case ITEM_ADGUARD:
      throw new Error('srs: adguard rule items are not supported');
    case ITEM_QUERY_TYPE:
    case ITEM_SOURCE_PORT:
    case ITEM_PORT: {
      const count = reader.uvarint();
      reader.take(count * 2);
      return;
    }
    case ITEM_NETWORK_TYPE: {
      const count = reader.uvarint();
      reader.take(count);
      return;
    }
    case ITEM_NETWORK_IS_EXPENSIVE:
    case ITEM_NETWORK_IS_CONSTRAINED:
      reader.byte();
      return;
    case ITEM_WIFI_SSID:
    case ITEM_WIFI_BSSID:
      throw new Error(`srs: unsupported rule item ${item}`);
    default:
      if (STRING_LIST_ITEMS.has(item)) {
        readStringList(reader);
        return;
      }
      throw new Error(`srs: unsupported rule item ${item}`);
  }
}

function readStringList(reader) {
  const count = reader.uvarint();
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = reader.string();
  return out;
}

function readIpSet(reader) {
  const version = reader.byte();
  if (version !== 1) throw new Error(`srs: unsupported ip set version ${version}`);
  const rangeCount = reader.uint64BE();
  const cidrs = [];
  for (let i = 0; i < rangeCount; i += 1) {
    const fromLength = reader.uvarint();
    const from = reader.take(fromLength);
    const toLength = reader.uvarint();
    const to = reader.take(toLength);
    if (fromLength !== toLength || (fromLength !== 4 && fromLength !== 16)) {
      throw new Error('srs: invalid ip range');
    }
    rangeToCidrs(from, to, fromLength === 4 ? 4 : 6, cidrs);
  }
  return cidrs;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

function bigIntToBytes(value, byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i -= 1) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function rangeToCidrs(fromBytes, toBytes, family, out) {
  const totalBits = family === 4 ? 32 : 128;
  let from = bytesToBigInt(fromBytes);
  const to = bytesToBigInt(toBytes);
  if (from > to) throw new Error('srs: invalid ip range order');
  while (from <= to) {
    let hostBits = 0n;
    while (hostBits < BigInt(totalBits)) {
      const next = hostBits + 1n;
      const blockSize = 1n << next;
      if ((from & (blockSize - 1n)) !== 0n) break;
      if (from + blockSize - 1n > to) break;
      hostBits = next;
    }
    out.push({
      family,
      bytes: bigIntToBytes(from, totalBits / 8),
      prefix: totalBits - Number(hostBits),
    });
    from += 1n << hostBits;
  }
}

const PREFIX_LABEL = '\r';
const ROOT_LABEL = '\n';

function readDomainSet(reader, parsed) {
  const flag = reader.byte();
  if (flag !== 0) throw new Error(`srs: unsupported domain set flag ${flag}`);
  const leaves = reader.uint64Slice();
  const labelBitmap = reader.uint64Slice();
  const labelsLength = reader.uvarint();
  const labels = reader.take(labelsLength);
  const keys = enumerateSuccinctKeys(leaves, labelBitmap, labels);

  const domainMap = new Set();
  const prefixSet = new Set();
  const rootSuffixes = [];
  for (const rawKey of keys) {
    const key = reverseString(rawKey);
    if (key[0] === PREFIX_LABEL) prefixSet.add(key.slice(1));
    else if (key[0] === ROOT_LABEL) rootSuffixes.push(key.slice(1));
    else domainMap.add(key);
  }
  for (const suffix of rootSuffixes) parsed.suffixes.push(suffix);
  for (const rawPrefix of prefixSet) {
    if (rawPrefix[0] === '.') {
      const rootDomain = rawPrefix.slice(1);
      if (domainMap.has(rootDomain)) {
        domainMap.delete(rootDomain);
        parsed.suffixes.push(rootDomain);
        continue;
      }
      parsed.strictSuffixes.push(rootDomain);
      continue;
    }
    parsed.suffixes.push(rawPrefix);
  }
  for (const domain of domainMap) parsed.domains.push(domain);
}

function bitAt(words, index) {
  return Number((words[index >> 6] >> BigInt(index & 63)) & 1n);
}

function enumerateSuccinctKeys(leaves, labelBitmap, labels) {
  const children = [[]];
  const totalBits = labelBitmap.length * 64;
  let node = 0;
  let labelIdx = 0;
  let bit = 0;
  while (node < children.length) {
    if (bit >= totalBits) throw new Error('srs: malformed succinct set');
    if (bitAt(labelBitmap, bit)) {
      node += 1;
    } else {
      if (labelIdx >= labels.length) throw new Error('srs: malformed succinct set');
      children[node].push({ label: labels[labelIdx], child: children.length });
      children.push([]);
      labelIdx += 1;
    }
    bit += 1;
  }
  if (labelIdx !== labels.length) throw new Error('srs: malformed succinct set');

  const keys = [];
  const decoder = new TextDecoder();
  const walk = (nodeId, path) => {
    if (nodeId < leaves.length * 64 && bitAt(leaves, nodeId)) {
      keys.push(decoder.decode(new Uint8Array(path)));
    }
    for (const { label, child } of children[nodeId]) {
      path.push(label);
      walk(child, path);
      path.pop();
    }
  };
  walk(0, []);
  return keys;
}

function reverseString(text) {
  return [...text].reverse().join('');
}

function parseJsonSource(raw) {
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error('rule-set: not a valid .srs binary or JSON source');
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
    throw new Error('rule-set: JSON source must contain a rules array');
  }
  const parsed = emptyParsed();
  for (const rule of doc.rules) {
    if (!rule || typeof rule !== 'object') throw new Error('rule-set: rule must be an object');
    if (rule.type === 'logical' || rule.rules !== undefined) {
      throw new Error('rule-set: logical rules are not supported');
    }
    if (rule.invert) throw new Error('rule-set: inverted rules are not supported');
    for (const domain of asList(rule.domain)) parsed.domains.push(String(domain).toLowerCase());
    for (const suffix of asList(rule.domain_suffix)) {
      const text = String(suffix).toLowerCase();
      if (text.startsWith('.')) parsed.strictSuffixes.push(text.slice(1));
      else parsed.suffixes.push(text);
    }
    for (const keyword of asList(rule.domain_keyword)) parsed.keywords.push(String(keyword));
    for (const regex of asList(rule.domain_regex)) parsed.regexes.push(String(regex));
    for (const entry of asList(rule.ip_cidr)) {
      const cidr = parseCidr(String(entry));
      if (!cidr) throw new Error(`rule-set: invalid ip_cidr entry "${entry}"`);
      parsed.cidrs.push(cidr);
    }
  }
  return parsed;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function buildRuleSetMatchers(parsed) {
  const domainBuilder = new FlatDomainSuffixTreeBuilder();
  let entryId = 0;
  for (const domain of parsed.domains) domainBuilder.addFull(domain, entryId++);
  for (const suffix of parsed.suffixes) domainBuilder.addSuffix(suffix, entryId++);
  for (const suffix of parsed.strictSuffixes) domainBuilder.addStrictSuffix(suffix, entryId++);
  for (const keyword of parsed.keywords) domainBuilder.addPlain(keyword, entryId++);
  for (const regex of parsed.regexes) domainBuilder.addRegex(regex, entryId++);

  const ipBuilder = new FlatIpRadixBuilder();
  for (const cidr of parsed.cidrs) ipBuilder.add(cidr.family, cidr.bytes, cidr.prefix);

  return {
    domainTree: domainBuilder.finish(),
    ipRadix: ipBuilder.finish(),
    counts: {
      domains: parsed.domains.length,
      suffixes: parsed.suffixes.length,
      strictSuffixes: parsed.strictSuffixes.length,
      keywords: parsed.keywords.length,
      regexes: parsed.regexes.length,
      cidrs: parsed.cidrs.length,
    },
  };
}
