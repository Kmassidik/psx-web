/**
 * MDEC constant tables and VLC bitstream primitives — spec-copied from no$psx
 * "MDEC Decompression" (psx-spx.consoledev.net/macroblockdecodermdec) and the
 * Sony BS/VLC codebook. Pure data + bit I/O, no imports.
 */

/** scalefactor[0..7] = cos((0..7)*90/8); [1..7] multiplied by sqrt(2). */
export const SCALEFACTOR = [
  1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379,
] as const;

/** Zigzag scan order: ZIGZAG[i] = raster index of the i-th RLE coefficient. */
export const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
] as const;

/**
 * AAN integer IDCT prescale, raster layout: AANSCALES[r] = round(scalefactor[x]
 * * scalefactor[y] * 2^20) for raster (x,y) — the reference aanscales table
 * (DC entry 2^20). Values match pcsx-redux's table entry for entry.
 */
export const AANSCALES = (() => {
  const t = new Int32Array(64);
  for (let r = 0; r < 64; r++) {
    t[r] = Math.round(SCALEFACTOR[r & 7]! * SCALEFACTOR[r >> 3]! * 2 ** 20);
  }
  return t;
})();

/** SCALER denominators of the reference AAN decoder (see mdec.ts comments). */
export const AAN_PRESCALE_SCALE = 4;
export const AAN_EXTRA = 12;

/**
 * Standard IDCT scale matrix MDEC(3) uploads: 64 signed halfwords, 14
 * fractional bits (s0..s7 * sqrt(2) * 0x4000; hardware uses the upper 13 bits).
 */
export const STANDARD_SCALE_TABLE = new Int16Array([
  0x5a82, 0x5a82, 0x5a82, 0x5a82, 0x5a82, 0x5a82, 0x5a82, 0x5a82, 0x7d8a, 0x6a6d, 0x471c, 0x18f8,
  0xe707, 0xb8e3, 0x9592, 0x8275, 0x7641, 0x30fb, 0xcf04, 0x89be, 0x89be, 0xcf04, 0x30fb, 0x7641,
  0x6a6d, 0xe707, 0x8275, 0xb8e3, 0x471c, 0x7d8a, 0x18f8, 0x9592, 0x5a82, 0xa57d, 0xa57d, 0x5a82,
  0x5a82, 0xa57d, 0xa57d, 0x5a82, 0x471c, 0x8275, 0x18f8, 0x6a6d, 0x9592, 0xe707, 0x7d8a, 0xb8e3,
  0x30fb, 0x89be, 0x7641, 0xcf04, 0xcf04, 0x7641, 0x89be, 0x30fb, 0x18f8, 0xb8e3, 0x6a6d, 0x8275,
  0x7d8a, 0x9592, 0x471c, 0xe707,
]);

export interface VlcCode {
  code: number;
  bits: number;
}

/** Max encodable level per run (VLC book width). */
export const VLC_MAX_LEVEL = [
  40, 18, 5, 4, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1,
] as const;

/** Row builder: takes {code,bits} pairs, pads to the 40-slot book width. */
const vlcRow = (pairs: readonly (readonly [number, number])[]): VlcCode[] => {
  const row: VlcCode[] = pairs.map(([code, bits]) => ({ code, bits }));
  while (row.length < 40) row.push({ code: 0, bits: 0 });
  return row;
};

/**
 * Sony VLC run-level codebook (BS bitstream, "decode16" front-end). Each entry
 * is the code for a POSITIVE level; the negative level is code|1 (low bit =
 * sign). Indexed [run][level-1]; {code:0,bits:0} = off the book (use ESC).
 * Codes are prefix-free over lengths 2..17 (checked against libpress).
 */
export const VLC_RUN: readonly VlcCode[][] = [
  vlcRow([[0x6, 3], [0x8, 5], [0xa, 6], [0xc, 8], [0x4c, 9], [0x42, 9], [0x14, 11], [0x3a, 13],
    [0x30, 13], [0x26, 13], [0x20, 13], [0x34, 14], [0x32, 14], [0x30, 14], [0x2e, 14], [0x3e, 15],
    [0x3c, 15], [0x3a, 15], [0x38, 15], [0x36, 15], [0x34, 15], [0x32, 15], [0x30, 15], [0x2e, 15],
    [0x2c, 15], [0x2a, 15], [0x28, 15], [0x26, 15], [0x24, 15], [0x22, 15], [0x20, 15], [0x30, 16],
    [0x2e, 16], [0x2c, 16], [0x2a, 16], [0x28, 16], [0x26, 16], [0x24, 16], [0x22, 16], [0x20, 16]]),
  vlcRow([[0x6, 4], [0xc, 7], [0x4a, 9], [0x18, 11], [0x36, 13], [0x2c, 14], [0x2a, 14],
    [0x3e, 16], [0x3c, 16], [0x3a, 16], [0x38, 16], [0x36, 16], [0x34, 16], [0x32, 16],
    [0x26, 17], [0x24, 17], [0x22, 17], [0x20, 17]]),
  vlcRow([[0xa, 5], [0x8, 8], [0x16, 11], [0x28, 13], [0x28, 14]]),
  vlcRow([[0xe, 6], [0x48, 9], [0x38, 13], [0x26, 14]]),
  vlcRow([[0xc, 6], [0x1e, 11], [0x24, 13]]),
  vlcRow([[0xe, 7], [0x12, 11], [0x24, 14]]),
  vlcRow([[0xa, 7], [0x3c, 13], [0x28, 17]]),
  vlcRow([[0x8, 7], [0x2a, 13]]),
  vlcRow([[0xe, 8], [0x22, 13]]),
  vlcRow([[0xa, 8], [0x22, 14]]),
  vlcRow([[0x4e, 9], [0x20, 14]]),
  vlcRow([[0x46, 9], [0x34, 17]]),
  vlcRow([[0x44, 9], [0x32, 17]]),
  vlcRow([[0x40, 9], [0x30, 17]]),
  vlcRow([[0x1c, 11], [0x2e, 17]]),
  vlcRow([[0x1a, 11], [0x2c, 17]]),
  vlcRow([[0x10, 11], [0x2a, 17]]),
  vlcRow([[0x3e, 13]]),
  vlcRow([[0x34, 13]]),
  vlcRow([[0x32, 13]]),
  vlcRow([[0x2e, 13]]),
  vlcRow([[0x2c, 13]]),
  vlcRow([[0x3e, 14]]),
  vlcRow([[0x3c, 14]]),
  vlcRow([[0x3a, 14]]),
  vlcRow([[0x38, 14]]),
  vlcRow([[0x36, 14]]),
  vlcRow([[0x3e, 17]]),
  vlcRow([[0x3c, 17]]),
  vlcRow([[0x3a, 17]]),
  vlcRow([[0x38, 17]]),
  vlcRow([[0x36, 17]]),
];

/** {0x2,2}: end-of-block code. */
export const VLC_EOB: VlcCode = { code: 0x2, bits: 2 };
/** {0x1,6}: escape code, followed by the raw 16-bit run-level word. */
export const VLC_ESC: VlcCode = { code: 0x1, bits: 6 };
/** Raw 10-bit DC slot value marking End of Frame (BS v1/v2). */
export const BS_END_OF_FRAME = 0x1ff;

/** Decoded VLC symbol: a run/level pair, or the escape/EOB specials. */
export interface VlcDecodeEntry {
  run: number;
  level: number;
  escape: boolean;
  eob: boolean;
}

/**
 * Reverse lookup keyed by (bits << 20) | code — a code value is only unique
 * within its length. Both signs of every level are inserted (negative = code|1).
 */
export const VLC_DECODE_TABLE: ReadonlyMap<number, VlcDecodeEntry> = (() => {
  const t = new Map<number, VlcDecodeEntry>();
  const key = (code: number, bits: number): number => ((bits & 0x3ff) << 20) | (code & 0xfffff);
  t.set(key(VLC_EOB.code, VLC_EOB.bits), { run: 0, level: 0, escape: false, eob: true });
  t.set(key(VLC_ESC.code, VLC_ESC.bits), { run: 0, level: 0, escape: true, eob: false });
  for (let run = 0; run < 32; run++) {
    const maxLvl = VLC_MAX_LEVEL[run]!;
    for (let lvl = 1; lvl <= maxLvl; lvl++) {
      const c = VLC_RUN[run]![lvl - 1]!;
      if (c.bits === 0) continue;
      t.set(key(c.code, c.bits), { run, level: lvl, escape: false, eob: false });
      t.set(key(c.code | 1, c.bits), { run, level: -lvl, escape: false, eob: false });
    }
  }
  return t;
})();

/** MPEG-1 DC size code (ISO/IEC 11172-2 tables B-12/B-13) for BS v3 delta DC. */
export interface DcSizeCode {
  code: number;
  length: number;
}

export const DC_SIZE_LUMA: readonly DcSizeCode[] = [
  { code: 0b100, length: 3 },
  { code: 0b00, length: 2 },
  { code: 0b01, length: 2 },
  { code: 0b101, length: 3 },
  { code: 0b110, length: 3 },
  { code: 0b1110, length: 4 },
  { code: 0b11110, length: 5 },
  { code: 0b111110, length: 6 },
  { code: 0b1111110, length: 7 },
];

export const DC_SIZE_CHROMA: readonly DcSizeCode[] = [
  { code: 0b00, length: 2 },
  { code: 0b01, length: 2 },
  { code: 0b10, length: 2 },
  { code: 0b110, length: 3 },
  { code: 0b1110, length: 4 },
  { code: 0b11110, length: 5 },
  { code: 0b111110, length: 6 },
  { code: 0b1111110, length: 7 },
  { code: 0b11111110, length: 8 },
];

/**
 * MSB-first bit writer whose byte layout matches BitReader: bits pack into
 * 16-bit words that land little-endian (first bits in the HIGH byte of each
 * halfword). The reference BitWriter does the same, so its streams decode
 * with a `data[2i] | data[2i+1]<<8` MSB-first reader.
 */
export class BitWriter {
  readonly bytes: number[] = [];
  private acc = 0;
  private n = 0;

  /** Append `bits` (<=24) of `code`, MSB first. */
  put(code: number, bits: number): void {
    this.acc = this.acc * 2 ** bits + (code & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 16) {
      this.n -= 16;
      const hw = Math.floor(this.acc / 2 ** this.n) & 0xffff;
      this.bytes.push(hw & 0xff, hw >>> 8);
    }
    this.acc %= 2 ** this.n;
  }

  /** Pad to a halfword, then to a whole number of 32-bit words. */
  finish(): void {
    if (this.n > 0) {
      const hw = (this.acc * 2 ** (16 - this.n)) & 0xffff;
      this.bytes.push(hw & 0xff, hw >>> 8);
      this.n = 0;
    }
    while (this.bytes.length & 3) this.bytes.push(0);
  }
}

/** MSB-first bit reader over little-endian halfwords (mirror of BitWriter). */
export class BitReader {
  overrun = false;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  get(bits: number): number {
    let v = 0;
    for (let b = 0; b < bits; b++) {
      const hw = this.pos >> 4;
      const bit = this.pos & 15;
      let word = 0;
      if (hw * 2 + 1 < this.data.length) {
        word = this.data[hw * 2]! | (this.data[hw * 2 + 1]! << 8);
      } else {
        this.overrun = true;
      }
      v = (v << 1) | ((word >>> (15 - bit)) & 1);
      this.pos++;
    }
    return v;
  }

  /** Peek `bits` without consuming or latching overrun. */
  peek(bits: number): number {
    const savedPos = this.pos;
    const savedOverrun = this.overrun;
    const v = this.get(bits);
    this.pos = savedPos;
    this.overrun = savedOverrun;
    return v;
  }
}
