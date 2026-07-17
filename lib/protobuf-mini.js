export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

export class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.end = bytes.length;
  }

  eof() {
    return this.offset >= this.end;
  }

  readVarint() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.offset >= this.end) throw new Error('protobuf: varint past end');
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('protobuf: varint too long');
    }
  }

  readVarintNumber() {
    return Number(this.readVarint());
  }

  readTag() {
    const value = this.readVarintNumber();
    return { field: value >>> 3, wireType: value & 7 };
  }

  readLengthDelimited() {
    const length = this.readVarintNumber();
    if (this.offset + length > this.end) throw new Error('protobuf: ld past end');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readString() {
    return new TextDecoder('utf-8').decode(this.readLengthDelimited());
  }

  skip(wireType) {
    if (wireType === WIRE_VARINT) this.readVarint();
    else if (wireType === WIRE_FIXED64) this.advance(8);
    else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = this.readVarintNumber();
      this.advance(length);
    }
    else if (wireType === WIRE_FIXED32) this.advance(4);
    else throw new Error(`protobuf: unknown wire type ${wireType}`);
  }

  advance(count) {
    if (this.offset + count > this.end) throw new Error('protobuf: skip past end');
    this.offset += count;
  }
}
