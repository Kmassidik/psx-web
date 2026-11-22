/**
 * MDEC — Macroblock Decoder (Phase 3). Mirrors the no$psx MDEC chapter:
 * ports 0x1F801820/24, MDEC(0)..(3) commands, run-level decode ("decode8":
 * bi-directional fixed-length halfword stream, no$psx rl_decode_block) and the
 * Sony BS bitstream front end ("decode16": variable-length huffman, BS v1/v2/v3),
 * IDCT (AAN fast path + real-matrix general path), YUV→RGB / mono output.
 *
 * Tables are spec-copied in mdec-tables.ts. Semi-transparency (MDEC0 bit 25,
 * STP) is stored into status bit 23 and emitted as the 15bpp bit 15 / RGBA
 * alpha flag only; no blending is performed — the hardware does not blend.
 *
 * Numeric model notes (psx-spx + pcsx-redux hardware measurements):
 * - Standard scale/quant tables take the AAN fast IDCT (80 muls). The MDEC(3)
 *   matrix is applied verbatim, so a non-standard matrix switches to
 *   real_idct_core (1024 muls, any matrix is faithfully applied).
 * - The output stage rounds half down and masks to signed 9 bits BEFORE
 *   saturating, so an overrun comes out black, not white (measured on
 *   silicon by pcsx-redux; psx-spx hints at it for y_to_mono).
 */
import {
  AANSCALES,
  AAN_EXTRA,
  AAN_PRESCALE_SCALE,
  STANDARD_SCALE_TABLE,
  ZIGZAG,
} from "./mdec-tables";
import { decode16 as decode16Bs, encode16 as encode16Bs } from "./mdec-bs";

const EOB = 0xfe00; // end-of-block / padding halfword
const BLOCKS = 6; // Cr,Cb,Y1,Y2,Y3,Y4 per colored macroblock
const S = 64; // coefficients per 8x8 block

/** SCALER(x,n): divide by 2^n, ties round up (reference AAN decoder). */
const scaler = (x: number, n: number): number => (x + ((1 << n) >> 1)) >> n;
/** SCALE8: divide by 2^20 with ties round DOWN (measured output rounding). */
const scale8 = (c: number): number => (c + (1 << 19) - 1) >> 20;
/** SCALE5: divide by 2^23, ties up — 15bpp stage unmeasured on hardware. */
const scale5 = (c: number): number => (c + (1 << 22)) >> 23;
/** Signed 10-bit field (RLE_VAL). */
const val10 = (w: number): number => (w << 22) >> 22;
/** Saturate to the spec's signed 11-bit dequant range [-0x400, +0x3FF]. */
const sat11 = (v: number): number => (v > 0x3ff ? 0x3ff : v < -0x400 ? -0x400 : v);

/** Colour matrix at 2^10 (reference MULR/MULB/MULG2; B uses 1.7754, not 1.772). */
const MULR = (a: number): number => 1436 * a;
const MULB = (a: number): number => 1818 * a;
const MULG = (cb: number, cr: number): number => -352 * cb - 731 * cr;

/** AAN fixed constants, 12 significant bits (reference FIX_*). */
const FIX_1_082392200 = scaler(18159528, 12); // B6 = sqrt(2)/scalefactor[2]
const FIX_1_414213562 = scaler(23726566, 12); // A4 = sqrt(2)
const FIX_1_847759065 = scaler(31000253, 12); // A2 = sqrt(2)*scalefactor[2]
const FIX_2_613125930 = scaler(43840978, 12); // B2 = scalefactor[2]*2

/** Reference clamp8: 9-bit wrap THEN saturate, +128 to unsigned. */
const clamp8 = (c: number): number => {
  const v = ((c & 0x1ff) ^ 0x100) - 0x100;
  if (v < -128) return 0;
  if (v > 127) return 255;
  return v + 128;
};
/** 15bpp sibling: saturate to 5 bits around a 16 centre. */
const clamp5 = (c: number): number => (c < -16 ? 0 : c > 15 ? 31 : c + 16);

/** One AAN butterfly stage over columns (stride 8) or rows (stride 1). */
const aanStage = (b: Int32Array, cols: boolean, active: number): void => {
  for (let i = 0; i < 8; i++) {
    if ((active & (1 << i)) === 0) continue; // flat axis: keep raw (reference `continue`)
    const base = cols ? i : i * 8;
    const st = (r: number): number => (cols ? b[base + r * 8]! : b[base + r]!);
    const ld = (r: number, v: number): void => {
      if (cols) b[base + r * 8] = v;
      else b[base + r] = v;
    };
    let z10 = st(0) + st(4);
    let z11 = st(0) - st(4);
    let z13 = st(2) + st(6);
    let z12 = scaler((st(2) - st(6)) * FIX_1_414213562, 12) - z13;
    const tmp0 = z10 + z13;
    const tmp3 = z10 - z13;
    const tmp1 = z11 + z12;
    const tmp2 = z11 - z12;
    z13 = st(3) + st(5);
    z10 = st(3) - st(5);
    z11 = st(1) + st(7);
    z12 = st(1) - st(7);
    const tmp7 = z11 + z13;
    const z5 = (z12 - z10) * FIX_1_847759065;
    const tmp6 = scaler(z10 * FIX_2_613125930 + z5, 12) - tmp7;
    const tmp5 = scaler((z11 - z13) * FIX_1_414213562, 12) - tmp6;
    const tmp4 = scaler(z12 * FIX_1_082392200 - z5, 12) + tmp5;
    ld(0, tmp0 + tmp7);
    ld(7, tmp0 - tmp7);
    ld(1, tmp1 + tmp6);
    ld(6, tmp1 - tmp6);
    ld(2, tmp2 + tmp5);
    ld(5, tmp2 - tmp5);
    ld(4, tmp3 + tmp4);
    ld(3, tmp3 - tmp4);
  }
};

/**
 * AAN fast IDCT (reference fast_idct_core family, 80 muls). usedCol === -1
 * means DC-only; otherwise a bitmask of columns 0..7 with AC energy in rows
 * 1..7 — ONLY those columns get the column butterfly. Columns without AC
 * energy flat-fill from their row-0 coefficient and keep the RAW value (a
 * constant column needs no transform, and the AAN butterfly is not
 * idempotent — running it on raw values corrupts them, reference `continue`).
 */
const idctAan = (blk: Int32Array, usedCol: number): void => {
  if (usedCol === -1) {
    const v = blk[0]!;
    for (let i = 1; i < S; i++) blk[i] = v;
    return;
  }
  for (let i = 0; i < 8; i++) {
    if ((usedCol & (1 << i)) === 0 && blk[i] !== 0) {
      const v = blk[i]!;
      for (let r = 1; r < 8; r++) blk[i + r * 8] = v;
    }
  }
  aanStage(blk, true, usedCol);
  if (usedCol === 1) {
    // All ACs in column 0 (vertical frequencies): rows are constant → no row
    // butterfly, just spread each row's column-0 value.
    for (let r = 0; r < 8; r++) {
      const v = blk[r * 8]!;
      for (let x = 1; x < 8; x++) blk[r * 8 + x] = v;
    }
  } else {
    aanStage(blk, false, 0xff);
  }
};

/**
 * real_idct_core: dst = src * scaletable with src diagonally mirrored (column
 * pass then row pass), two passes, `(sum + 0xFFF) >> 13` rounding. The MDEC
 * applies ANY MDEC(3) matrix faithfully; the *1024 on pass 2 puts the result
 * in the shared 2^10 output domain of the AAN path.
 */
const idctReal = (blk: Int32Array, scale: Int16Array): void => {
  const temp = new Int32Array(S);
  let src: Int32Array = blk;
  let dst: Int32Array = temp;
  for (let pass = 0; pass < 2; pass++) {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let z = 0; z < 8; z++) {
          sum += src[y + z * 8]! * (scale[x + z * 8]! >> 3);
        }
        let v = (sum + 0xfff) >> 13;
        if (pass === 1) v *= 1024;
        dst[x + y * 8] = v;
      }
    }
    const t = src;
    src = dst;
    dst = t;
  }
  blk.set(src);
};

interface MdecTables {
  qtY: Uint8Array;
  qtUV: Uint8Array;
  iqY: Int32Array;
  iqUV: Int32Array;
  scale: Int16Array;
  customScale: boolean;
}

const makeTables = (): MdecTables => {
  const t: MdecTables = {
    qtY: new Uint8Array(64),
    qtUV: new Uint8Array(64),
    iqY: new Int32Array(64),
    iqUV: new Int32Array(64),
    scale: new Int16Array(64),
    customScale: false,
  };
  t.scale.set(STANDARD_SCALE_TABLE);
  return t;
};

/** Prescale a raw quant table into the AAN domain (reference prescaleQuantTable). */
const prescaleQuant = (iqtab: Int32Array, qt: Uint8Array): void => {
  for (let i = 0; i < S; i++) {
    iqtab[i] = qt[i]! * scaler(AANSCALES[ZIGZAG[i]!]!, AAN_PRESCALE_SCALE);
  }
};

/** Reference saturateAanAc: spec's 11-bit clamp in the DIVIDED (/8) domain. */
const satAc = (x: number): number => {
  const v = Math.trunc((x + 4) / 8);
  if (v > 0x3ff) return 0x3ff * 8;
  if (v < -0x400) return -0x400 * 8;
  return x;
};

/**
 * Dequantize one block from the run-level stream (no$psx rl_decode_block,
 * AAN fast path) into blk[0..63], run the AAN IDCT, and report the used-column
 * mask via used[0] (-1 = DC-only). Returns the position after the block, or -1
 * when the stream is exhausted where a block header was expected. Leading FE00
 * padding is skipped per the spec's @@skip arm.
 */
const dequantBlockAan = (
  blk: Int32Array,
  stream: Uint16Array,
  pos: number,
  iqtab: Int32Array,
  qtab: Uint8Array,
  used: Int32Array,
): number => {
  const n = stream.length;
  blk.fill(0);
  let p = pos;
  while (p < n && stream[p] === EOB) p++; // block-header padding
  if (p >= n) return -1;
  let rl = stream[p++]!;
  const qScale = (rl >>> 10) & 0x3f;
  // DC: signed10 * qt[0] with NO q_scale and NO /8 (the spec line marked "(?)";
  // confirmed on hardware by pcsx-redux). q_scale 0 = signed10 * 2, no table.
  const dc = val10(rl);
  const specDc = qScale === 0 ? dc * 2 : dc * qtab[0]!;
  const satDc = sat11(specDc);
  blk[0] =
    qScale !== 0 && satDc === specDc
      ? scaler(iqtab[0]! * dc, AAN_EXTRA - 3)
      : scaler(satDc * scaler(AANSCALES[0]!, AAN_PRESCALE_SCALE), AAN_EXTRA - 3);
  let k = 0;
  let usedCol = 0;
  for (;;) {
    if (p >= n) break; // stream ends mid-block: AC tail stays zero
    rl = stream[p++]!;
    if (rl === EOB) break;
    k += ((rl >>> 10) & 0x3f) + 1;
    if (k > 63) break;
    const v = val10(rl);
    const dest = qScale === 0 ? k : ZIGZAG[k]!;
    if (qScale === 0) {
      // Special mode: no quant table, doubled value, NO zigzag (hardware
      // measured: k=2 decodes raster position 2, not zscan[2]). The spec's
      // 11-bit clamp is a no-op here: signed10*2 spans [-1024, +1022].
      blk[dest] = scaler(v * 2 * 8 * scaler(AANSCALES[k]!, AAN_PRESCALE_SCALE), AAN_EXTRA);
    } else {
      // Ordinary route: keep the ORIGINAL un-divided product into the AAN
      // prescale; the spec's saturation lives in the divided domain and only
      // bites when it saturates (clamping the divided value is an 8x error).
      blk[dest] = scaler(satAc(v * qtab[k]! * qScale) * (iqtab[k]! / (qtab[k] !== 0 ? qtab[k]! : 1)), AAN_EXTRA);
    }
    usedCol |= dest > 7 ? 1 << (dest & 7) : 0;
  }
  used[0] = k === 0 ? -1 : usedCol;
  idctAan(blk, used[0]!);
  return p;
};

export class Mdec {
  /** MDEC1 status image (no$psx 1F801824h.Read layout). */
  regs = 0x80040000;

  private readonly tables: MdecTables = makeTables();
  private readonly blk = new Int32Array(BLOCKS * S);
  private readonly usedScratch = new Int32Array(1);
  private command = 0; // MDEC0 word
  private remaining = -1; // status 0-15: parameter words remaining minus 1
  private inWords: number[] = []; // parameter words for MDEC(2)/(3)
  private rl = new Uint16Array(0); // run-level stream for MDEC(1)
  private rlPos = 0;
  private out = new Uint32Array(0);
  private outPos = 0;
  private dmaIn = false;
  private dmaOut = false;
  private currentBlock = 4;

  /** MDEC0 write (0x1F801820): command word; parameters follow via pushWord. */
  write(data: number): void {
    this.command = data >>> 0;
    const cmd = (data >>> 29) & 7;
    if (cmd === 1) {
      this.remaining = (data & 0xffff) - 1;
      this.rl = new Uint16Array((data & 0xffff) * 2);
      this.rlPos = 0;
    } else if (cmd === 2) {
      this.remaining = (data & 1) !== 0 ? 31 : 15; // 64 bytes per table
      this.inWords = [];
    } else if (cmd === 3) {
      this.remaining = 31; // 64 halfwords = 32 words
      this.inWords = [];
    } else {
      // MDEC(0) and invalid MDEC(4..7): reflect bits, expect no parameters.
      this.remaining = -1;
      this.inWords = [];
    }
    this.updateStatus();
  }

  /** MDEC1 write (0x1F801824): bit31 reset, bit30/29 DMA enables. */
  writeControl(data: number): void {
    if ((data & 0x80000000) !== 0) {
      // no$psx: abort any command, set status = 80040000h literally.
      this.reset();
      return;
    }
    this.dmaIn = (data & 0x40000000) !== 0;
    this.dmaOut = (data & 0x20000000) !== 0;
    this.updateStatus();
  }

  /** MDEC1 control bit31: abort any command, status := 80040000h. */
  reset(): void {
    this.command = 0;
    this.remaining = -1;
    this.inWords = [];
    this.rl = new Uint16Array(0);
    this.rlPos = 0;
    this.out = new Uint32Array(0);
    this.outPos = 0;
    this.regs = 0x80040000;
  }

  /** Push one 32-bit parameter/data word (DMA0 or CPU writes to MDEC0). */
  pushWord(w: number): void {
    if (this.remaining < 0) return;
    const cmd = (this.command >>> 29) & 7;
    if (cmd === 1) {
      if (this.rlPos + 1 < this.rl.length) {
        this.rl[this.rlPos] = w & 0xffff;
        this.rl[this.rlPos + 1] = (w >>> 16) & 0xffff;
        this.rlPos += 2;
      }
      this.remaining--;
      if (this.remaining < 0) this.decode();
    } else {
      this.inWords.push(w >>> 0);
      this.remaining--;
      if (this.remaining < 0) this.applyTable();
    }
    this.updateStatus();
  }

  /** Shared-contract alias: feed a halfword stream (DMA0 ordering). */
  pushMacroblock(data: Uint16Array): void {
    for (let i = 0; i + 1 < data.length; i += 2) {
      this.pushWord((data[i]! | (data[i + 1]! << 16)) >>> 0);
    }
  }

  /** Read decoded output (DMA1 / CPU reads from 0x1F801820); drains the FIFO. */
  readOutput(): Uint32Array {
    const r = this.out.slice(this.outPos);
    this.outPos = this.out.length;
    this.updateStatus();
    return r;
  }

  /** 15bpp halfword view of the remaining output (GPU-style transfers). */
  readOutput16(): Uint16Array {
    const u32 = this.readOutput();
    const out = new Uint16Array(u32.length * 2);
    new Uint32Array(out.buffer).set(u32);
    return out;
  }

  private applyTable(): void {
    const cmd = (this.command >>> 29) & 7;
    const u8 = new Uint8Array(this.inWords.length * 4);
    const dv = new DataView(u8.buffer);
    this.inWords.forEach((w, i) => dv.setUint32(i * 4, w, true));
    if (cmd === 2) {
      this.tables.qtY.set(u8.subarray(0, 64));
      prescaleQuant(this.tables.iqY, this.tables.qtY);
      if ((this.command & 1) !== 0) {
        this.tables.qtUV.set(u8.subarray(64, 128));
        prescaleQuant(this.tables.iqUV, this.tables.qtUV);
      }
    } else if (cmd === 3) {
      for (let i = 0; i < 64; i++) this.tables.scale[i] = dv.getInt16(i * 2, true);
      this.tables.customScale = this.tables.scale.some((v, i) => v !== STANDARD_SCALE_TABLE[i]);
    }
  }

  /**
   * Count macroblocks the stream can supply, walking block boundaries exactly
   * like dequantBlockAan (EOB terminator, or k > 63 on a fully defined block;
   * leading FE00 padding skipped). Returns blocks, not macroblocks.
   */
  private countBlocks(start: number): number {
    const n = this.rl.length;
    let pos = start;
    let blocks = 0;
    for (;;) {
      while (pos < n && this.rl[pos] === EOB) pos++;
      if (pos >= n) break;
      blocks++;
      pos++; // header word
      let k = 0;
      for (;;) {
        if (pos >= n) return blocks; // partial trailing block counts
        const w = this.rl[pos++]!;
        if (w === EOB) break;
        k += ((w >>> 10) & 0x3f) + 1;
        if (k > 63) break;
      }
    }
    return blocks;
  }

  /** Decode every macroblock in the buffered run-level stream. */
  private decode(): void {
    const depth = (this.command >>> 27) & 3;
    const mono = depth < 2; // 4bpp/8bpp: single Y block per macroblock
    const rgba = depth === 3; // 15bpp: packed as RGBA u32 words
    const stp = (this.command & 0x02000000) !== 0;
    const signed = (this.command & 0x04000000) !== 0;
    const nHalf = this.rl.length;
    let pos = 0;
    while (pos < nHalf && this.rl[pos] === EOB) pos++;
    const blocks = this.countBlocks(pos);
    const mbCount = mono ? blocks : Math.floor(blocks / BLOCKS);
    const bytesPerMb = mono ? (depth === 0 ? 32 : 64) : rgba ? 256 * 4 : 256 * 3;
    this.out = new Uint32Array(Math.ceil((mbCount * bytesPerMb) / 4));
    const o8 = new Uint8Array(this.out.buffer);
    let op = 0;
    for (let mb = 0; mb < mbCount; mb++) {
      if (mono) {
        const next = this.decodeBlock(pos, 0);
        if (next < 0) break;
        pos = next;
        this.currentBlock = 4;
        this.emitMono(o8, op, depth === 0, signed);
        op += bytesPerMb;
      } else {
        for (let b = 0; b < BLOCKS; b++) {
          const next = this.decodeBlock(pos, b);
          if (next < 0) break;
          pos = next;
          this.currentBlock = b < 2 ? b + 4 : b - 2; // Cr,Cb (idle) / Y1..Y4
        }
        this.emitColor(o8, op, rgba, stp);
        op += bytesPerMb;
      }
    }
    this.outPos = 0;
    this.updateStatus();
  }

  /** Decode block `b` of the current macroblock; returns next position or -1. */
  private decodeBlock(pos: number, b: number): number {
    const blk = this.blk.subarray(b * S, b * S + S);
    const chroma = b < 2;
    const iq = chroma ? this.tables.iqUV : this.tables.iqY;
    const qt = chroma ? this.tables.qtUV : this.tables.qtY;
    if (this.tables.customScale) {
      return this.dequantReal(blk, pos, iq, qt);
    }
    const next = dequantBlockAan(blk, this.rl, pos, iq, qt, this.usedScratch);
    return next;
  }

  /** General-path dequant (spec 11-bit clamp, no AAN) + real-matrix IDCT. */
  private dequantReal(blk: Int32Array, pos: number, iq: Int32Array, qt: Uint8Array): number {
    const n = this.rl.length;
    blk.fill(0);
    let p = pos;
    while (p < n && this.rl[p] === EOB) p++;
    if (p >= n) return -1;
    let rl = this.rl[p++]!;
    const qScale = (rl >>> 10) & 0x3f;
    const dc = val10(rl);
    blk[0] = sat11(qScale === 0 ? dc * 2 : dc * qt[0]!);
    let k = 0;
    for (;;) {
      if (p >= n) break;
      rl = this.rl[p++]!;
      if (rl === EOB) break;
      k += ((rl >>> 10) & 0x3f) + 1;
      if (k > 63) break;
      const v = val10(rl);
      const val = qScale === 0 ? v * 2 : Math.trunc((v * qt[k]! * qScale + 4) / 8);
      blk[qScale === 0 ? k : ZIGZAG[k]!] = sat11(val);
    }
    // real_idct_core yields raw pixel-domain values; scale it into the
    // shared 2^10 output domain AFTER the transform so one colour stage
    // serves both paths.
    idctReal(blk, this.tables.scale);
    for (let i = 0; i < S; i++) blk[i] = blk[i]! * 1024;
    return p;
  }

  /** Emit one mono 8x8 macroblock (4bpp low-nibble-first or 8bpp). */
  private emitMono(o8: Uint8Array, off: number, bpp4: boolean, signed: boolean): void {
    const blk = this.blk;
    for (let i = 0; i < S; i++) {
      // 2^10 prescale → pixel domain, round-half-down (shared output stage).
      let y = scale8(blk[i]! << 10);
      y &= 0x1ff; // 9-bit wrap...
      y = y > 255 ? y - 512 : y; // ...to signed 9 bits...
      if (y < -128) y = -128;
      else if (y > 127) y = 127; // ...then saturate to 8 bits (y_to_mono)
      if (!signed) y ^= 0x80;
      if (bpp4) {
        const nib = (y >> 4) & 0x0f;
        if ((i & 1) === 0) o8[off + (i >> 1)] = nib;
        else o8[off + (i >> 1)] = o8[off + (i >> 1)]! | (nib << 4);
      } else {
        o8[off + i] = y;
      }
    }
  }

  /** Emit one colored 16x16 macroblock: RGB24 bytes or RGBA u32 words. */
  private emitColor(o8: Uint8Array, off: number, rgba: boolean, stp: boolean): void {
    const blk = this.blk;
    const Cr = 0;
    const Cb = S;
    const Y1 = 2 * S;
    const Y2 = 3 * S;
    const Y3 = 4 * S;
    const Y4 = 5 * S;
    const pxBytes = rgba ? 4 : 3;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const xr = x < 8 ? x : x - 8;
        const yr = y < 8 ? y : y - 8;
        const yIdx =
          y < 8 ? (x < 8 ? Y1 + yr * 8 + xr : Y2 + yr * 8 + xr) : x < 8 ? Y3 + yr * 8 + xr : Y4 + yr * 8 + xr;
        const ci = (y >> 1) * 8 + (x >> 1); // chroma is 8x8 for 16x16 pixels
        const yv = blk[yIdx]!;
        const cr = blk[Cr + ci]!;
        const cb = blk[Cb + ci]!;
        const o = off + (y * 16 + x) * pxBytes;
        const r = clamp8(scale8((yv << 10) + MULR(cr)));
        const g = clamp8(scale8((yv << 10) + MULG(cb, cr)));
        const b = clamp8(scale8((yv << 10) + MULB(cb)));
        o8[o] = r;
        o8[o + 1] = g;
        o8[o + 2] = b;
        if (rgba) o8[o + 3] = stp ? 0x80 : 0;
      }
    }
  }

  /** Rebuild the no$psx status image from current state. */
  private updateStatus(): void {
    const depth = (this.command >>> 27) & 3;
    const outEmpty = this.outPos >= this.out.length;
    const busy = this.remaining > 0;
    const cmd = (this.command >>> 29) & 7;
    const inFull =
      this.remaining === 0 ||
      (busy && cmd === 1 && this.rl.length > 0 && this.rlPos >= this.rl.length);
    let r = 0;
    if (outEmpty || this.remaining < 0) r |= 1 << 31; // FIFO1 data-out empty
    if (inFull) r |= 1 << 30; // FIFO0 data-in full
    if (busy) r |= 1 << 29; // BUSY
    if (this.dmaIn && !busy) r |= 1 << 28; // DREQ0
    if (this.dmaOut && !outEmpty) r |= 1 << 27; // DREQ1
    r |= (depth & 3) << 25; // output depth (CMD 28-27)
    if ((this.command & 0x04000000) !== 0) r |= 1 << 24; // signed (CMD 26)
    if ((this.command & 0x02000000) !== 0) r |= 1 << 23; // STP (CMD 25)
    r |= (this.currentBlock & 7) << 16;
    r |= this.remaining >= 0 ? this.remaining & 0xffff : 0xffff;
    this.regs = r >>> 0;
  }

  /** BS bitstream front end ("decode16") — see mdec-bs.ts. */
  decode16(bs: Uint8Array): Uint16Array {
    return decode16Bs(bs);
  }

  /** Encode run-level halfwords to a BS v2 bitstream (decode16 inverse). */
  encode16(rl: Uint16Array): Uint8Array {
    return encode16Bs(rl);
  }
}
