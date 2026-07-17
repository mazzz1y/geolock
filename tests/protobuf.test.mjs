import { strict as assert } from 'node:assert';
import { Reader, WIRE_LENGTH_DELIMITED, WIRE_VARINT, WIRE_FIXED32, WIRE_FIXED64 } from '../lib/protobuf-mini.js';
import { Writer } from './fixtures/protobuf-writer.mjs';

export const tests = [
  {
    name: 'varint roundtrip',
    run: () => {
      const writer = new Writer();
      writer.writeTag(1, WIRE_VARINT);
      writer.writeVarint(150);
      const reader = new Reader(writer.finish());
      const tag = reader.readTag();
      assert.equal(tag.field, 1);
      assert.equal(tag.wireType, WIRE_VARINT);
      assert.equal(reader.readVarintNumber(), 150);
    },
  },
  {
    name: 'string roundtrip',
    run: () => {
      const writer = new Writer();
      writer.writeString(2, 'hello');
      const reader = new Reader(writer.finish());
      const tag = reader.readTag();
      assert.equal(tag.field, 2);
      assert.equal(tag.wireType, WIRE_LENGTH_DELIMITED);
      assert.equal(reader.readString(), 'hello');
    },
  },
  {
    name: 'skip unknown',
    run: () => {
      const writer = new Writer();
      writer.writeUint32(99, 12345);
      writer.writeString(2, 'after');
      const reader = new Reader(writer.finish());
      const first = reader.readTag();
      assert.equal(first.field, 99);
      reader.skip(first.wireType);
      const second = reader.readTag();
      assert.equal(reader.readString(), 'after');
      assert.equal(second.field, 2);
    },
  },
  {
    name: 'skip length-delimited advances past payload',
    run: () => {
      const writer = new Writer();
      writer.writeString(1, 'first');
      writer.writeString(2, 'second');
      const reader = new Reader(writer.finish());
      const tag = reader.readTag();
      assert.equal(tag.field, 1);
      reader.skip(tag.wireType);
      const next = reader.readTag();
      assert.equal(next.field, 2);
      assert.equal(reader.readString(), 'second');
    },
  },
  {
    name: 'skip fixed64 past end throws',
    run: () => {
      const reader = new Reader(new Uint8Array([1, 2, 3]));
      assert.throws(() => reader.skip(WIRE_FIXED64), /past end/);
    },
  },
  {
    name: 'skip fixed32 past end throws',
    run: () => {
      const reader = new Reader(new Uint8Array([1, 2]));
      assert.throws(() => reader.skip(WIRE_FIXED32), /past end/);
    },
  },
  {
    name: 'skip length-delimited past end throws',
    run: () => {
      const reader = new Reader(new Uint8Array([10, 0xff]));
      assert.throws(() => reader.skip(WIRE_LENGTH_DELIMITED), /past end/);
    },
  },
  {
    name: 'skip varint past end throws',
    run: () => {
      const reader = new Reader(new Uint8Array([0x80]));
      assert.throws(() => reader.skip(WIRE_VARINT), /past end/);
    },
  },
];
