/**
 * CHD v4/v5 loader (MAME "Compressed Hunks of Data").
 *
 * Layout per libretro's observed-bytes FORMAT.md (all integers big-endian):
 *  - v4 header (108 bytes): tag@0, length@8, version@12, flags@16, compression
 *    enum@20 (0 none, 1/2 zlib, 3 av), totalhunks@24, logicalbytes u64@28,
 *    metaoffset u64@36, hunkbytes@44. Hunk map sits right after the header:
 *    16-byte entries (u64 offset, u32 crc, 24-bit length, type in flags low
 *    nibble), followed by a 16-byte "EndOfListCookie" terminator.
 *  - v5 header (124 bytes): 4x 4CC compressor slots@16, logicalbytes u64@32,
 *    mapoffset u64@40, metaoffset u64@48, hunkbytes@56, unitbytes@60.
 *    Uncompressed v5 images (all compressor slots zero) use a flat u32 map:
 *    entry * hunkbytes = byte offset, entry 0 = hole (all-zero hunk).
 *
 * Types 1 (zlib), 2 (stored), 3 (mini: 8-byte pattern in the offset field,
 * repeated to hunkSize) and 4 (self-reference) are read here; 5 (parent) and
 * 6 (secondary codec) make parseChd return undefined. The v5 compressed map
 * (Huffman-coded bitstream) is likewise unsupported.
 *
 * The zlib codec is RAW DEFLATE (no zlib wrapper) in every CHD version, so
 * hunks inflate via DecompressionStream("deflate-raw") — the same stream
 * Bun.deflateSync produces. CRC-32s in map entries are not verified.
 * Raw hunks are exposed; sector/MSF mapping stays in disc.ts.
 */
export interface Chd {
  hunkSize: number; // uncompressed bytes per hunk
  hunks: number; // hunk count
  readHunk(i: number): Promise<Uint8Array>;
}

const MAGIC = "MComprHD";
const V4_HEADER = 108;
const V5_HEADER = 124;
const V4_MAP_ENTRY = 16;

// v3/v4 map entry types (flags byte low nibble).
const TYPE_COMPRESSED = 1;
const TYPE_STORED = 2;
const TYPE_MINI = 3;
const TYPE_SELF_REF = 4;

interface MapEntry {
  type: number;
  offset: number; // byte offset of data (or source hunk index for self-refs, or mini pattern via raw bytes)
  len: number;
}

async function inflateRaw(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== expected) {
    throw new Error(`CHD hunk inflate: got ${out.byteLength} bytes, want ${expected}`);
  }
  return out;
}

/** Type 3 "mini" hunk: the 8 bytes stored in the offset field, tiled to hunkSize. */
function miniHunk(data: Uint8Array, entryStart: number, hunkSize: number): Uint8Array {
  const pattern = data.subarray(entryStart, entryStart + 8);
  const out = new Uint8Array(hunkSize);
  for (let o = 0; o < hunkSize; o += 8) out.set(pattern.subarray(0, Math.min(8, hunkSize - o)), o);
  return out;
}

function parseV4(data: Uint8Array, dv: DataView): Chd | undefined {
  const codec = dv.getUint32(20, false);
  if (codec === 3) return undefined; // av codec unsupported; 0/1/2 all decode here
  const hunkSize = dv.getUint32(44, false);
  const logical = Number(dv.getBigUint64(28, false));
  if (hunkSize === 0 || logical === 0) return undefined;
  const hunks = Math.ceil(logical / hunkSize);
  const entries: (MapEntry | undefined)[] = [];
  for (let i = 0; i < hunks; i++) {
    const e = V4_HEADER + i * V4_MAP_ENTRY;
    if (e + V4_MAP_ENTRY > data.byteLength) return undefined;
    const type = dv.getUint8(e + 15) & 0x0f;
    if (type === 0 || type > TYPE_SELF_REF) return undefined; // invalid / parent / secondary
    entries.push({
      type,
      offset: Number(dv.getBigUint64(e, false)),
      len: dv.getUint16(e + 12, false) | (dv.getUint8(e + 14) << 16),
    });
  }
  return {
    hunkSize,
    hunks,
    readHunk: (i: number) => readMappedHunk(data, hunkSize, entries, i),
  };
}

function parseV5(data: Uint8Array, dv: DataView): Chd | undefined {
  // Four 4CC compressor slots @16: any nonzero tag means a compressed map /
  // compressed hunks, both unsupported (documented contract).
  for (let c = 16; c < 32; c++) if (dv.getUint8(c) !== 0) return undefined;
  const hunkSize = dv.getUint32(56, false);
  const logical = Number(dv.getBigUint64(32, false));
  const mapOffset = Number(dv.getBigUint64(40, false));
  if (hunkSize === 0 || logical === 0) return undefined;
  const hunks = Math.ceil(logical / hunkSize);
  return {
    hunkSize,
    hunks,
    async readHunk(i: number): Promise<Uint8Array> {
      if (i < 0 || i >= hunks) throw new Error(`hunk ${i} out of range (have ${hunks})`);
      const e = mapOffset + i * 4;
      if (e + 4 > data.byteLength) throw new Error(`CHD map entry ${i} past end of file`);
      const v = dv.getUint32(e, false);
      if (v === 0) return new Uint8Array(hunkSize); // hole: all-zero hunk
      const offset = v * hunkSize;
      if (offset + hunkSize > data.byteLength) throw new Error(`CHD hunk ${i} data past end of file`);
      return data.subarray(offset, offset + hunkSize);
    },
  };
}

/** v4 readHunk: walk the parsed map, inflating/tile-ing/chasing as the type asks. */
async function readMappedHunk(
  data: Uint8Array,
  hunkSize: number,
  entries: (MapEntry | undefined)[],
  i: number,
  seen: Set<number> = new Set(),
): Promise<Uint8Array> {
  if (i < 0 || i >= entries.length) throw new Error(`hunk ${i} out of range (have ${entries.length})`);
  if (seen.has(i)) throw new Error(`CHD self-reference cycle at hunk ${i}`);
  seen.add(i);
  const e = entries[i];
  if (!e) throw new Error(`hunk ${i} marked invalid in map`);
  switch (e.type) {
    case TYPE_STORED:
      return data.subarray(e.offset, e.offset + e.len);
    case TYPE_COMPRESSED:
      return inflateRaw(data.subarray(e.offset, e.offset + e.len), hunkSize);
    case TYPE_MINI: {
      // offset field IS the 8-byte pattern; its file position is the entry start.
      const entryStart = V4_HEADER + i * V4_MAP_ENTRY;
      return miniHunk(data, entryStart, hunkSize);
    }
    case TYPE_SELF_REF:
      return readMappedHunk(data, hunkSize, entries, e.offset, seen);
    default:
      throw new Error(`hunk ${i} has unsupported type ${e.type}`);
  }
}

/** Parse a CHD v4/v5 image from memory. Returns undefined for unsupported layouts. */
export async function parseChd(data: Uint8Array): Promise<Chd | undefined> {
  if (data.byteLength < V4_HEADER) return undefined;
  const magic = new TextDecoder("ascii").decode(data.subarray(0, 8));
  if (magic !== MAGIC) return undefined;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (dv.getUint32(12, false)) {
    case 4:
      return parseV4(data, dv);
    case 5:
      return parseV5(data, dv);
    default:
      return undefined; // v1-v3 and future versions unsupported
  }
}
