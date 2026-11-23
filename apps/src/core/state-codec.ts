/** Versioned, checksummed, schema-driven binary encoding for emulator state. */
export const SAVE_STATE_VERSION = 1;
const MAGIC = 0x52505358; // "RPSX"
const HEADER_SIZE = 16;

type TypedKind = "u8" | "u16" | "u32" | "i16" | "i32";
export type StateSchema =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "typed"; typed: TypedKind; length: number }
  | { kind: "array"; item: StateSchema; max: number; length?: number }
  | { kind: "object"; fields: readonly (readonly [string, StateSchema])[] };

const constructors = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i16: Int16Array, i32: Int32Array,
} as const;
const sizes = { u8: 1, u16: 2, u32: 4, i16: 2, i32: 4 } as const;

const fail = (message: string): never => { throw new Error(`Invalid save state: ${message}`); };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function measure(value: unknown, schema: StateSchema): number {
  switch (schema.kind) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("non-finite number");
      return 8;
    case "boolean":
      if (typeof value !== "boolean") fail("expected boolean");
      return 1;
    case "enum": {
      const index = typeof value === "string" ? schema.values.indexOf(value) : -1;
      if (index < 0 || index > 255) fail("unknown enum value");
      return 1;
    }
    case "typed": {
      if (!(value instanceof constructors[schema.typed]) || (value as { length: number }).length !== schema.length) {
        fail(`expected ${schema.typed}[${schema.length}]`);
      }
      return (value as { byteLength: number }).byteLength;
    }
    case "array": {
      if (!Array.isArray(value)) fail("expected array");
      const array = value as unknown[];
      if (array.length > schema.max || (schema.length !== undefined && array.length !== schema.length)) {
        fail("invalid array length");
      }
      let size = 4;
      for (const item of array) size += measure(item, schema.item);
      return size;
    }
    case "object": {
      if (!isObject(value)) fail("expected object");
      let size = 0;
      for (const [key, field] of schema.fields) size += measure((value as Record<string, unknown>)[key], field);
      return size;
    }
  }
}

class Writer {
  readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer); }
  u8(value: number): void { this.view.setUint8(this.offset++, value); }
  u32(value: number): void { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  f64(value: number): void { this.view.setFloat64(this.offset, value, true); this.offset += 8; }

  write(value: unknown, schema: StateSchema): void {
    switch (schema.kind) {
      case "number": this.f64(value as number); return;
      case "boolean": this.u8(value ? 1 : 0); return;
      case "enum": this.u8(schema.values.indexOf(value as string)); return;
      case "typed": {
        const typed = value as Uint8Array | Uint16Array | Uint32Array | Int16Array | Int32Array;
        const size = sizes[schema.typed];
        for (let i = 0; i < typed.length; i++) {
          const item = typed[i]!;
          if (size === 1) this.u8(item);
          else if (size === 2) { this.view.setUint16(this.offset, item & 0xffff, true); this.offset += 2; }
          else { this.view.setUint32(this.offset, item >>> 0, true); this.offset += 4; }
        }
        return;
      }
      case "array": {
        const array = value as unknown[];
        this.u32(array.length);
        for (const item of array) this.write(item, schema.item);
        return;
      }
      case "object":
        for (const [key, field] of schema.fields) this.write((value as Record<string, unknown>)[key], field);
        return;
    }
  }
}

class Reader {
  readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number { return this.bytes.length - this.offset; }
  need(size: number): void { if (size > this.remaining) fail("truncated payload"); }
  u8(): number { this.need(1); return this.view.getUint8(this.offset++); }
  u32(): number { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  read(schema: StateSchema): unknown {
    switch (schema.kind) {
      case "number": {
        const value = this.f64();
        if (!Number.isFinite(value)) fail("non-finite number");
        return value;
      }
      case "boolean": {
        const value = this.u8();
        if (value > 1) fail("invalid boolean");
        return value === 1;
      }
      case "enum": {
        const index = this.u8();
        if (index >= schema.values.length) fail("invalid enum value");
        return schema.values[index]!;
      }
      case "typed": {
        const size = sizes[schema.typed];
        this.need(schema.length * size);
        const result = new constructors[schema.typed](schema.length);
        for (let i = 0; i < result.length; i++) {
          if (size === 1) result[i] = this.u8();
          else if (size === 2) {
            result[i] = this.view.getUint16(this.offset, true); this.offset += 2;
          } else {
            result[i] = this.view.getUint32(this.offset, true); this.offset += 4;
          }
        }
        return result;
      }
      case "array": {
        const length = this.u32();
        if (length > schema.max || (schema.length !== undefined && length !== schema.length) ||
            length > this.remaining) fail("invalid array length");
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) result.push(this.read(schema.item));
        return result;
      }
      case "object": {
        const result: Record<string, unknown> = {};
        for (const [key, field] of schema.fields) result[key] = this.read(field);
        return result;
      }
    }
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb8_8320 : 0);
  CRC_TABLE[i] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function encodeState(state: unknown, schema: StateSchema): Uint8Array {
  const payloadSize = measure(state, schema);
  const bytes = new Uint8Array(HEADER_SIZE + payloadSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, SAVE_STATE_VERSION, true);
  view.setUint32(8, payloadSize, true);
  const writer = new Writer(bytes);
  writer.offset = HEADER_SIZE;
  writer.write(state, schema);
  view.setUint32(12, crc32(bytes.subarray(HEADER_SIZE)), true);
  return bytes;
}

export function decodeState(bytes: Uint8Array, schema: StateSchema): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_SIZE) fail("truncated header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail("bad magic");
  const version = view.getUint32(4, true);
  if (version !== SAVE_STATE_VERSION) fail(`unsupported version ${version}`);
  const payloadSize = view.getUint32(8, true);
  if (payloadSize !== bytes.length - HEADER_SIZE) fail("truncated or trailing data");
  const payload = bytes.subarray(HEADER_SIZE);
  if (crc32(payload) !== view.getUint32(12, true)) fail("checksum mismatch");
  const reader = new Reader(payload);
  const result = reader.read(schema);
  if (reader.remaining !== 0) fail("trailing payload data");
  return result;
}
