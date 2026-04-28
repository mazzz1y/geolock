import { WIRE_LENGTH_DELIMITED, WIRE_VARINT } from '../../lib/protobuf-mini.js';

export class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  writeVarint(value) {
    let v = BigInt(value);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    this.push(Uint8Array.from(out));
  }

  writeTag(field, wireType) {
    this.writeVarint((field << 3) | wireType);
  }

  writeLengthDelimited(field, bytes) {
    this.writeTag(field, WIRE_LENGTH_DELIMITED);
    this.writeVarint(bytes.length);
    this.push(bytes);
  }

  writeString(field, text) {
    this.writeLengthDelimited(field, new TextEncoder().encode(text));
  }

  writeUint32(field, value) {
    this.writeTag(field, WIRE_VARINT);
    this.writeVarint(value);
  }

  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  finish() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
