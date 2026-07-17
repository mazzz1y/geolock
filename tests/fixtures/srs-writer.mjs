import { deflateSync } from 'node:zlib';

class ByteWriter {
  constructor() {
    this.parts = [];
  }

  byte(value) {
    this.parts.push(Uint8Array.of(value & 0xff));
  }

  bytes(array) {
    this.parts.push(array instanceof Uint8Array ? array : Uint8Array.from(array));
  }

  uvarint(value) {
    let v = BigInt(value);
    const out = [];
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        out.push(b);
        break;
      }
      out.push(b | 0x80);
    }
    this.bytes(out);
  }

  string(text) {
    const encoded = new TextEncoder().encode(text);
    this.uvarint(encoded.length);
    this.bytes(encoded);
  }

  uint64BE(value) {
    let v = BigInt(value);
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i -= 1) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.bytes(out);
  }

  uint64Slice(values) {
    this.uvarint(values.length);
    for (const value of values) this.uint64BE(value);
  }

  finish() {
    let total = 0;
    for (const part of this.parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function reverseString(text) {
  return [...text].reverse().join('');
}

export function buildSuccinctSet(keys) {
  const sorted = [...keys].sort();
  const leaves = [];
  const labelBitmapBits = [];
  const labels = [];

  const setLeafBit = i => {
    while (i >> 6 >= leaves.length) leaves.push(0n);
    leaves[i >> 6] |= 1n << BigInt(i & 63);
  };

  const queue = [{ s: 0, e: sorted.length, col: 0 }];
  for (let i = 0; i < queue.length; i += 1) {
    const elt = queue[i];
    let { s } = elt;
    if (s < elt.e && elt.col === sorted[s].length) {
      s += 1;
      setLeafBit(i);
    }
    for (let j = s; j < elt.e;) {
      const frm = j;
      const ch = sorted[frm].charCodeAt(elt.col);
      for (; j < elt.e && sorted[j].charCodeAt(elt.col) === ch; j += 1) { /* ... */ }
      queue.push({ s: frm, e: j, col: elt.col + 1 });
      labels.push(ch);
      labelBitmapBits.push(0);
    }
    labelBitmapBits.push(1);
  }

  const labelBitmap = [];
  for (let i = 0; i < labelBitmapBits.length; i += 1) {
    while (i >> 6 >= labelBitmap.length) labelBitmap.push(0n);
    if (labelBitmapBits[i]) labelBitmap[i >> 6] |= 1n << BigInt(i & 63);
  }

  return { leaves, labelBitmap, labels: Uint8Array.from(labels) };
}

export function domainSetKeys({ domains = [], suffixes = [], strictSuffixes = [], legacy = false }) {
  const keys = [];
  const seen = new Set();
  const add = key => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (const suffix of suffixes) {
    if (legacy) {
      add(reverseString(suffix));
      add(reverseString('\r.' + suffix));
    } else {
      add(reverseString('\n' + suffix));
    }
  }
  for (const suffix of strictSuffixes) {
    add(reverseString('\r.' + suffix));
  }
  for (const domain of domains) {
    add(reverseString(domain));
  }
  return keys;
}

export function writeDomainSetItem(writer, spec) {
  const keys = domainSetKeys(spec);
  const set = buildSuccinctSet(keys);
  writer.byte(2);
  writer.byte(0);
  writer.uint64Slice(set.leaves);
  writer.uint64Slice(set.labelBitmap);
  writer.uvarint(set.labels.length);
  writer.bytes(set.labels);
}

export function writeStringListItem(writer, itemType, strings) {
  writer.byte(itemType);
  writer.uvarint(strings.length);
  for (const text of strings) writer.string(text);
}

export function writeIpSetItem(writer, itemType, ranges) {
  writer.byte(itemType);
  writer.byte(1);
  writer.uint64BE(ranges.length);
  for (const { from, to } of ranges) {
    writer.uvarint(from.length);
    writer.bytes(from);
    writer.uvarint(to.length);
    writer.bytes(to);
  }
}

export function buildSrs({ version = 3, rules = [], rawPayload = null }) {
  const payload = new ByteWriter();
  if (rawPayload) {
    payload.bytes(rawPayload);
  } else {
    payload.uvarint(rules.length);
    for (const rule of rules) {
      payload.byte(rule.logical ? 1 : 0);
      if (rule.logical) {
        payload.byte(rule.mode ?? 0);
        payload.uvarint(0);
        payload.byte(rule.invert ? 1 : 0);
        continue;
      }
      rule.write?.(payload);
      payload.byte(0xff);
      payload.byte(rule.invert ? 1 : 0);
    }
  }
  const compressed = deflateSync(payload.finish());
  const out = new Uint8Array(4 + compressed.length);
  out[0] = 0x53;
  out[1] = 0x52;
  out[2] = 0x53;
  out[3] = version;
  out.set(compressed, 4);
  return out;
}

export { ByteWriter };
