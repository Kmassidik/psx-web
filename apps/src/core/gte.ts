/**
 * PS1 Geometry Transformation Engine (GTE, coprocessor 2) — fixed-point
 * math coprocessor, from-scratch. Pure TS, no imports.
 *
 * References (cited per block, not guessed):
 *  - no$psx "Geometry Transformation Engine (GTE)" chapter
 *    (psx-spx.github.io/docs/geometrytransformationenginegte.md): command
 *    encoding, per-command formulas, FLAG bit map, saturation table, UNR
 *    division algorithm and table.
 *  - DuckStation src/core/gte.cpp (stenzek): used to confirm edge behavior
 *    only (IR3 flag-vs-store split in RTPS, buggy FC translation vector of
 *    MVMVA, 64-bit wrap of the UNR inner product, color FIFO push).
 *
 * Documented deviation from raw hardware: MAC register STORES saturate to
 * the 32-bit window instead of wrapping when the 44-bit result overflows
 * (assignment mandates saturate-not-wrap). For sf=1 paths the shifted
 * result cannot exceed 32 bits, so this is unobservable there; for sf=0
 * far-overflow stores it differs from DuckStation's truncation. UNVERIFIED
 * against real hardware for that sf=0 case only.
 */

// ---------------------------------------------------------------------------
// Saturation limits (no$psx "GTE Saturation" chapter)
// ---------------------------------------------------------------------------

const MAC0_MAX = 0x7fff_ffff;
const MAC0_MIN = -0x8000_0000;
/** MAC1..3 are 44-bit accumulators; FLAG bits record ±2^43 overflow. */
const MAC123_MAX = 0x07ff_ffff_ffff; // 2^43 - 1
const MAC123_MIN = -0x800_0000_0000; // -2^43
const IR123_MAX = 0x7fff;
const IR123_MIN = -0x8000;
/** IR0 saturates to 0..+1000h (no$psx FLAG bit 12). */
const IR0_MAX = 0x1000;
/** SXY2 screen coordinates saturate to -400h..+3FFh (FLAG bits 14/13). */
const SXY_MAX = 1023;
const SXY_MIN = -1024;
/** SZ/OTZ saturate to 0..FFFFh (FLAG bit 18). */
const SZ_MAX = 0xffff;

// FLAG register bits (no$psx cop2r63 map, "GTE Saturation" chapter).
const FLAG_OR = 1 << 31; // bit 31: error = OR of bits 30..23 and 18..13
const FLAG_MAC1_POS = 1 << 30;
const FLAG_MAC2_POS = 1 << 29;
const FLAG_MAC3_POS = 1 << 28;
const FLAG_MAC1_NEG = 1 << 27;
const FLAG_MAC2_NEG = 1 << 26;
const FLAG_MAC3_NEG = 1 << 25;
const FLAG_IR1_SAT = 1 << 24;
const FLAG_IR2_SAT = 1 << 23;
const FLAG_IR3_SAT = 1 << 22;
const FLAG_CR_SAT = 1 << 21;
const FLAG_CG_SAT = 1 << 20;
const FLAG_CB_SAT = 1 << 19;
const FLAG_SZ_OTZ_SAT = 1 << 18;
const FLAG_DIV_OVERFLOW = 1 << 17;
const FLAG_MAC0_POS = 1 << 16;
const FLAG_MAC0_NEG = 1 << 15;
const FLAG_SX2_SAT = 1 << 14;
const FLAG_SY2_SAT = 1 << 13;
const FLAG_IR0_SAT = 1 << 12;
/** Bits 30..12 are readable/writable; 0..11 always zero (no$psx). */
const FLAG_RW_MASK = 0x7f_ffff_f000 & 0xffff_ffff; // bits 30..12
const FLAG_ERROR_CHAIN = 0x7f87_e000; // bits 30..23 | 18..13

/**
 * UNR reciprocal table, no$psx "GTE Division Inaccuracy":
 * unr_table[i] = max(0, (40000h/(i+100h)+1)/2 - 101h), 257 entries.
 * Generated once at module load; equals the hard-coded hardware table.
 */
const UNR_TABLE = new Uint8Array([
  0xFF, 0xFD, 0xFB, 0xF9, 0xF7, 0xF5, 0xF3, 0xF1, 0xEF, 0xEE, 0xEC, 0xEA, 0xE8, 0xE6, 0xE4, 0xE3,
  0xE1, 0xDF, 0xDD, 0xDC, 0xDA, 0xD8, 0xD6, 0xD5, 0xD3, 0xD1, 0xD0, 0xCE, 0xCD, 0xCB, 0xC9, 0xC8,
  0xC6, 0xC5, 0xC3, 0xC1, 0xC0, 0xBE, 0xBD, 0xBB, 0xBA, 0xB8, 0xB7, 0xB5, 0xB4, 0xB2, 0xB1, 0xB0,
  0xAE, 0xAD, 0xAB, 0xAA, 0xA9, 0xA7, 0xA6, 0xA4, 0xA3, 0xA2, 0xA0, 0x9F, 0x9E, 0x9C, 0x9B, 0x9A,
  0x99, 0x97, 0x96, 0x95, 0x94, 0x92, 0x91, 0x90, 0x8F, 0x8D, 0x8C, 0x8B, 0x8A, 0x89, 0x87, 0x86,
  0x85, 0x84, 0x83, 0x82, 0x81, 0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x7A, 0x79, 0x78, 0x77, 0x75, 0x74,
  0x73, 0x72, 0x71, 0x70, 0x6F, 0x6E, 0x6D, 0x6C, 0x6B, 0x6A, 0x69, 0x68, 0x67, 0x66, 0x65, 0x64,
  0x63, 0x62, 0x61, 0x60, 0x5F, 0x5E, 0x5D, 0x5D, 0x5C, 0x5B, 0x5A, 0x59, 0x58, 0x57, 0x56, 0x55,
  0x54, 0x53, 0x53, 0x52, 0x51, 0x50, 0x4F, 0x4E, 0x4D, 0x4D, 0x4C, 0x4B, 0x4A, 0x49, 0x48, 0x48,
  0x47, 0x46, 0x45, 0x44, 0x43, 0x43, 0x42, 0x41, 0x40, 0x3F, 0x3F, 0x3E, 0x3D, 0x3C, 0x3C, 0x3B,
  0x3A, 0x39, 0x39, 0x38, 0x37, 0x36, 0x36, 0x35, 0x34, 0x33, 0x33, 0x32, 0x31, 0x31, 0x30, 0x2F,
  0x2E, 0x2E, 0x2D, 0x2C, 0x2C, 0x2B, 0x2A, 0x2A, 0x29, 0x28, 0x28, 0x27, 0x26, 0x26, 0x25, 0x24,
  0x24, 0x23, 0x22, 0x22, 0x21, 0x20, 0x20, 0x1F, 0x1E, 0x1E, 0x1D, 0x1D, 0x1C, 0x1B, 0x1B, 0x1A,
  0x19, 0x19, 0x18, 0x18, 0x17, 0x16, 0x16, 0x15, 0x15, 0x14, 0x14, 0x13, 0x12, 0x12, 0x11, 0x11,
  0x10, 0x0F, 0x0F, 0x0E, 0x0E, 0x0D, 0x0D, 0x0C, 0x0C, 0x0B, 0x0A, 0x0A, 0x09, 0x09, 0x08, 0x08,
  0x07, 0x07, 0x06, 0x06, 0x05, 0x05, 0x04, 0x04, 0x03, 0x03, 0x02, 0x02, 0x01, 0x01, 0x00, 0x00,
  0x00,
]);

// Control register indices (no$psx cop2r32-63 = cnt0-31 map).
const CR_RT = 0; // cnt0-4: RT11RT12, RT13RT21, RT22RT23, RT31RT32, RT33
const CR_TRX = 5;
const CR_TRY = 6;
const CR_TRZ = 7;
const CR_LLM = 8; // cnt8-12
const CR_RBK = 13;
const CR_GBK = 14;
const CR_BBK = 15;
const CR_LCM = 16; // cnt16-20
const CR_RFC = 21;
const CR_GFC = 22;
const CR_BFC = 23;
const CR_OFX = 24;
const CR_OFY = 25;
const CR_H = 26;
const CR_DQA = 27;
const CR_DQB = 28;
const CR_ZSF3 = 29;
const CR_ZSF4 = 30;
const CR_FLAG = 31;

/** Low/high signed halfword of a packed control/data word. */
function s16of(word: number, high: boolean): number {
  const v = (word >>> (high ? 16 : 0)) & 0xffff;
  return (v << 16) >> 16;
}

/** Arithmetic right shift for values beyond 32 bits (floor semantics). */
function sarShift(value: number, bits: number): number {
  return Math.floor(value / 2 ** bits);
}

/** Clamp a value into the 32-bit signed window (store saturation choice). */
function sat32(value: number): number {
  if (value > MAC0_MAX) return MAC0_MAX;
  if (value < MAC0_MIN) return MAC0_MIN;
  return value | 0;
}

export class GTE {
  /** Flat vertex file: VX0,VY0,VZ0,VX1,VY1,VZ1 (cop2r0-3). */
  readonly v = new Int16Array(6);
  /** 32-bit data register file cop2r0-31 (r4/5 = V2, r6 RGBC, r7 OTZ,
   *  r8 IR0, r9-11 IR1-3, r12-14 SXY FIFO, r16-19 SZ FIFO, r20-22 RGB FIFO,
   *  r24-27 MAC0-3, r30 LZCS). */
  readonly dr = new Int32Array(32);
  /** 32 control registers cnt0-31 (no$psx cop2r32-63). The ticket said
   *  Uint32Array(16), but the GTE has 32 control registers (FLAG is cnt31,
   *  RT33 is cnt4, DQB cnt28) — 16 cannot address them; using 32. */
  readonly cr = new Uint32Array(32);

  constructor() {
    // Documented typical values (no$psx Average Z / projection registers).
    this.cr[CR_ZSF3] = Math.trunc(0x1000 / 3);
    this.cr[CR_ZSF4] = Math.trunc(0x1000 / 4);
    this.cr[CR_H] = 0x1000;
  }

  // -- contract-named register views (public API boundary) ------------------

  get vxy0(): Int16Array {
    return this.v.subarray(0, 2);
  }
  set vxy0(pair: Int16Array) {
    this.v[0] = pair[0]!;
    this.v[1] = pair[1]!;
  }
  get vz0(): number {
    return this.v[2]!;
  }
  set vz0(value: number) {
    this.v[2] = value;
  }
  get vxy1(): Int16Array {
    return this.v.subarray(3, 5);
  }
  set vxy1(pair: Int16Array) {
    this.v[3] = pair[0]!;
    this.v[4] = pair[1]!;
  }
  get vz1(): number {
    return this.v[5]!;
  }
  set vz1(value: number) {
    this.v[5] = value;
  }
  /** V2 lives in cop2r4-5 (data words), like hardware. */
  get vx2(): number {
    return s16of(this.dr[4]!, false);
  }
  set vx2(value: number) {
    this.dr[4] = (this.dr[4]! & 0xffff0000) | (value & 0xffff);
  }
  get vy2(): number {
    return s16of(this.dr[4]!, true);
  }
  set vy2(value: number) {
    this.dr[4] = (this.dr[4]! & 0xffff) | ((value & 0xffff) << 16);
  }
  get vz2(): number {
    return this.dr[5]! << 16 >> 16;
  }
  set vz2(value: number) {
    this.dr[5] = value << 16 >> 16;
  }
  get ir1(): number {
    return this.dr[9]!;
  }
  set ir1(value: number) {
    this.dr[9] = value;
  }
  get ir2(): number {
    return this.dr[10]!;
  }
  set ir2(value: number) {
    this.dr[10] = value;
  }
  get ir3(): number {
    return this.dr[11]!;
  }
  set ir3(value: number) {
    this.dr[11] = value;
  }
  get mac0(): number {
    return this.dr[24]!;
  }
  set mac0(value: number) {
    this.dr[24] = value;
  }
  get mac1(): number {
    return this.dr[25]!;
  }
  get mac2(): number {
    return this.dr[26]!;
  }
  get mac3(): number {
    return this.dr[27]!;
  }
  /** Screen XY FIFO entries, packed SY<<16|SX (newest = sxy2). */
  get sxy0(): number {
    return this.dr[12]!;
  }
  set sxy0(value: number) {
    this.dr[12] = value;
  }
  get sxy1(): number {
    return this.dr[13]!;
  }
  set sxy1(value: number) {
    this.dr[13] = value;
  }
  get sxy2(): number {
    return this.dr[14]!;
  }
  set sxy2(value: number) {
    this.dr[14] = value;
  }
  get sz0(): number {
    return this.dr[16]! & 0xffff;
  }
  get sz1(): number {
    return this.dr[17]! & 0xffff;
  }
  get sz2(): number {
    return this.dr[18]! & 0xffff;
  }
  get sz3(): number {
    return this.dr[19]! & 0xffff;
  }
  get otz(): number {
    return this.dr[7]! & 0xffff;
  }
  get flag(): number {
    return this.cr[CR_FLAG]!;
  }
  get h(): number {
    return this.cr[CR_H]!;
  }
  set h(value: number) {
    this.cr[CR_H] = value;
  }
  get dqa(): number {
    return this.cr[CR_DQA]! << 16 >> 16;
  }
  set dqa(value: number) {
    this.cr[CR_DQA] = value << 16 >> 16;
  }
  get dqb(): number {
    return this.cr[CR_DQB]! | 0;
  }
  set dqb(value: number) {
    this.cr[CR_DQB] = value | 0;
  }
  /** LZCR read: leading 0s (positive LZCS) / 1s (negative), range 1..32
   *  (no$psx cop2r30-31). */
  get lzcr(): number {
    const v = this.dr[30]! >>> 0;
    if (v === 0) return 32;
    return (v & 0x8000_0000) !== 0 ? Math.clz32(~v >>> 0) : Math.clz32(v);
  }
  get lzcs(): number {
    return this.dr[30]!;
  }
  set lzcs(value: number) {
    this.dr[30] = value | 0;
  }

  // -- FLAG / MAC / IR primitives ------------------------------------------

  private macOverflowFlags(i: 1 | 2 | 3, value: number): void {
    if (value > MAC123_MAX) this.cr[CR_FLAG]! |= (FLAG_MAC1_POS >> (i - 1));
    else if (value < MAC123_MIN) this.cr[CR_FLAG]! |= (FLAG_MAC1_NEG >> (i - 1));
  }

  /** Store MACi: FLAG check on the pre-shift 44-bit value, then store the
   *  shifted result saturated to the 32-bit window (documented choice). */
  private setMac(i: 1 | 2 | 3, value: number, shift: number): void {
    this.macOverflowFlags(i, value);
    this.dr[24 + i] = sat32(sarShift(value, shift));
  }

  /** Store IRi with lm-dependent saturation (FLAG bits 24-22, no$psx). */
  private setIr(i: 1 | 2 | 3, value: number, lm: boolean): void {
    const min = lm ? 0 : IR123_MIN;
    if (value < min) {
      this.cr[CR_FLAG]! |= FLAG_IR1_SAT >> (i - 1);
      value = min;
    } else if (value > IR123_MAX) {
      this.cr[CR_FLAG]! |= FLAG_IR1_SAT >> (i - 1);
      value = IR123_MAX;
    }
    this.dr[8 + i] = value;
  }

  private setMac0(value: number): void {
    if (value > MAC0_MAX) this.cr[CR_FLAG]! |= FLAG_MAC0_POS;
    else if (value < MAC0_MIN) this.cr[CR_FLAG]! |= FLAG_MAC0_NEG;
    this.dr[24] = value | 0;
  }

  /** FLAG bit 31 = OR of bits 30..23 and 18..13 (no$psx bit 31). */
  private updateErrorBit(): void {
    if (this.cr[CR_FLAG]! & FLAG_ERROR_CHAIN) this.cr[CR_FLAG]! |= FLAG_OR;
    else this.cr[CR_FLAG]! &= ~FLAG_OR;
  }

  /** All commands clear FLAG bits 30..12 at start (no$psx FLAG note). */
  private clearFlag(): void {
    this.cr[CR_FLAG]! &= ~FLAG_RW_MASK;
  }

  // -- FIFOs ----------------------------------------------------------------

  /** SZ FIFO push, saturating 0..FFFFh (FLAG bit 18). */
  private pushSz(value: number): void {
    let v = value;
    if (v < 0) {
      v = 0;
      this.cr[CR_FLAG]! |= FLAG_SZ_OTZ_SAT;
    } else if (v > SZ_MAX) {
      v = SZ_MAX;
      this.cr[CR_FLAG]! |= FLAG_SZ_OTZ_SAT;
    }
    this.dr[16] = this.dr[17]!;
    this.dr[17] = this.dr[18]!;
    this.dr[18] = this.dr[19]!;
    this.dr[19] = v;
  }

  /** SXY FIFO push, saturating -400h..+3FFh (FLAG bits 14/13). */
  private pushSxy(sx: number, sy: number): void {
    let x = sx;
    if (x < SXY_MIN) {
      x = SXY_MIN;
      this.cr[CR_FLAG]! |= FLAG_SX2_SAT;
    } else if (x > SXY_MAX) {
      x = SXY_MAX;
      this.cr[CR_FLAG]! |= FLAG_SX2_SAT;
    }
    let y = sy;
    if (y < SXY_MIN) {
      y = SXY_MIN;
      this.cr[CR_FLAG]! |= FLAG_SY2_SAT;
    } else if (y > SXY_MAX) {
      y = SXY_MAX;
      this.cr[CR_FLAG]! |= FLAG_SY2_SAT;
    }
    this.dr[12] = this.dr[13]!;
    this.dr[13] = this.dr[14]!;
    this.dr[14] = (x & 0xffff) | ((y & 0xffff) << 16);
  }

  /** Color FIFO push: MACn>>4 saturated 0..FFh (FLAG bits 21-19), older
   *  entries move down, CODE from RGBC byte 3 (no$psx color commands). */
  private pushRgbFromMac(): void {
    const code = (this.dr[6]! >>> 24) & 0xff;
    const r = this.satColor(this.dr[25]! >> 4, FLAG_CR_SAT);
    const g = this.satColor(this.dr[26]! >> 4, FLAG_CG_SAT);
    const b = this.satColor(this.dr[27]! >> 4, FLAG_CB_SAT);
    this.dr[20] = this.dr[21]!;
    this.dr[21] = this.dr[22]!;
    this.dr[22] = r | (g << 8) | (b << 16) | (code << 24);
  }

  private satColor(value: number, flagBit: number): number {
    if (value < 0) {
      this.cr[CR_FLAG]! |= flagBit;
      return 0;
    }
    if (value > 0xff) {
      this.cr[CR_FLAG]! |= flagBit;
      return 0xff;
    }
    return value;
  }

  // -- division -------------------------------------------------------------

  /**
   * Hardware UNR division n = min(1FFFFh, (H*20000h/SZ3+1)/2) following the
   * no$psx "GTE Division Inaccuracy" algorithm exactly (same sequence as
   * DuckStation UNRDivide, including the min() limit that saturates to
   * 1FFFFh WITHOUT the overflow flag for results of exactly 20000h).
   * The DuckStation inner product uses u64 wrap; emulated via the modulo.
   */
  private unrDivide(lhs: number, rhs: number): number {
    // no$psx "GTE Division Inaccuracy" pseudocode, verbatim (33-bit via float):
    //   if (H < SZ3*2): z=count_leading_zeroes(SZ3); n=H<<z; d=SZ3<<z (8000..FFFF);
    //   u = unr_table[(d-7FC0h) SHR 7]+101h; d=(2000080h - d*u) SHR 8;
    //   d=(80h + d*u) SHR 8; n=min(1FFFFh, (n*d+8000h) SHR 16)
    //   else n=1FFFFh + FLAG.17/31
    if (rhs * 2 <= lhs) {
      this.cr[CR_FLAG]! |= FLAG_DIV_OVERFLOW;
      return 0x1ffff;
    }
    const z = rhs === 0 ? 16 : Math.clz32(rhs & 0xffff) - 16;
    const n = (lhs & 0xffff) * 2 ** z;
    let d = (rhs & 0xffff) * 2 ** z; // 8000h..FFFFh
    const u = UNR_TABLE![(d - 0x7fc0) >>> 7]! + 0x101;
    d = (0x2000_080 - d * u) >>> 8;
    d = (0x80 + d * u) >>> 8;
    return Math.min(0x1ffff, Math.floor((n * d + 0x8000) / 0x1_0000));
  }

  // -- matrix / vector decode -----------------------------------------------

  /** Row-major matrix element e (0..8) from packed control words at base:
   *  word+0 = e0|e1<<16, word+1 = e2|e3, word+2 = e4|e5, word+3 = e6|e7,
   *  word+4 low = e8 (RT33/L33/LB3 alone in the last word, no$psx). */
  private mat(base: number, e: number): number {
    return s16of(this.cr[base + (e >>> 1)]!, (e & 1) !== 0);
  }

  /** Vertex component; V0/V1 from the flat Int16Array, V2 from data words
   *  cop2r4-5. */
  private vec(i: 0 | 1 | 2, c: 0 | 1 | 2): number {
    if (i === 2) return s16of(c === 2 ? this.dr[5]! : this.dr[4]!, c === 1);
    return this.v[i * 3 + c]!;
  }

  /**
   * MVMVA-style row dots: acc_i = (T_i*1000h + M_i·V). Sets the 44-bit MAC
   * overflow FLAG per full row. DuckStation checks per partial add; partial
   * sums are bounded by 2^31 (legal 1.3.12 matrix * s16 vector terms) so a
   * difference is only reachable with translations near ±2^43 — single
   * per-row check chosen; UNVERIFIED for that pathological case.
   */
  private rowDots(matBase: number, t: number[], vx: number, vy: number, vz: number): number[] {
    const accs: number[] = [0, 0, 0];
    for (let row = 0; row < 3; row++) {
      const e = row * 3;
      const acc =
        t[row]! * 4096 +
        this.mat(matBase, e) * vx +
        this.mat(matBase, e + 1) * vy +
        this.mat(matBase, e + 2) * vz;
      this.macOverflowFlags((row + 1) as 1 | 2 | 3, acc);
      accs[row]! = acc;
    }
    return accs;
  }

  /** MACi = acc_i SAR (sf*12), IRi = MACi (lm saturation). */
  private storeRow(accs: number[], sf: boolean, lm: boolean): void {
    const shift = sf ? 12 : 0;
    for (let row = 0; row < 3; row++) {
      const i = (row + 1) as 1 | 2 | 3;
      this.setMac(i, accs[row]!, shift);
      this.setIr(i, this.dr[24 + i]!, lm);
    }
  }

  /**
   * MAC = MAC + (FC-MAC)*IR0 tail of the depth-cue color commands, in the
   * hardware's two-step form (no$psx "Details on MAC+(FC-MAC)*IR0"):
   * step 1 stores the (FC<<12 - MAC) SAR (sf*12) intermediate into IR with
   * lm=0-style saturation flags, step 2 adds IR0*IR back and re-saturates
   * with the real lm.
   */
  private interpolateColor(inMac: number[], sf: boolean, lm: boolean): void {
    const shift = sf ? 12 : 0;
    const fc = [this.cr[CR_RFC]! | 0, this.cr[CR_GFC]! | 0, this.cr[CR_BFC]! | 0];
    for (let i = 1; i <= 3; i++) {
      this.setMac(i as 1 | 2 | 3, fc[i - 1]! * 4096 - inMac[i - 1]!, shift);
      this.setIr(i as 1 | 2 | 3, this.dr[24 + i]!, false);
    }
    const ir0 = this.dr[8]!;
    for (let i = 1; i <= 3; i++) {
      const base = inMac[i - 1]!;
      this.setMac(i as 1 | 2 | 3, this.dr[8 + i]! * ir0 + base, shift);
      this.setIr(i as 1 | 2 | 3, this.dr[24 + i]!, lm);
    }
  }

  // -- commands -------------------------------------------------------------

  /**
   * RTPS core (no$psx "COP2 0180001h - RTPS - Perspective Transformation
   * (single)" formula block).
   * `last` selects the DQA/DQB depth-cue tail (true for RTPS and for the
   * third vertex of RTPT — DuckStation/specced behavior).
   */
  private rtps(vx: number, vy: number, vz: number, sf: boolean, lm: boolean, last: boolean): void {
    const shift = sf ? 12 : 0;
    const tr = [this.cr[CR_TRX]! | 0, this.cr[CR_TRY]! | 0, this.cr[CR_TRZ]! | 0];
    const accs = this.rowDots(CR_RT, tr, vx, vy, vz);

    this.setMac(1, accs[0]!, shift);
    this.setMac(2, accs[1]!, shift);
    this.setMac(3, accs[2]!, shift);
    // IR1/IR2 saturate per lm; the IR3 FLAG.22 check always acts as if
    // lm=0 (and tests acc SAR 12 even when sf=0) while the stored IR3 is
    // clamped from MAC3 with the real lm bound (no$psx RTPS note).
    this.setIr(1, this.dr[25]!, lm);
    this.setIr(2, this.dr[26]!, lm);
    this.setIr(3, sarShift(accs[2]!, 12), false);
    this.dr[11] = Math.min(Math.max(this.dr[27]!, lm ? 0 : IR123_MIN), IR123_MAX);

    // SZ3 = MAC3 SAR 12 for both sf (DuckStation pushes acc>>12 always;
    // hardware feeds the UNR divider the 1.3.12 value regardless of sf).
    // The no$psx formula "SZ3 = MAC3 SAR ((1-sf)*12)" is likely a spec
    // simplification; UNVERIFIED against real hardware for sf=0.
    this.pushSz(sarShift(accs[2]!, 12));

    // MAC0 = n*IR1 + OFX, SX2 = MAC0/10000h; same for IR2/OFY/SY2.
    const n = this.unrDivide(this.cr[CR_H]!, this.sz3);
    this.setMac0(n * this.ir1 + (this.cr[CR_OFX]! | 0));
    const sx = this.dr[24]! >> 16;
    this.setMac0(n * this.ir2 + (this.cr[CR_OFY]! | 0));
    const sy = this.dr[24]! >> 16;
    this.pushSxy(sx, sy);

    if (last) {
      // MAC0 = n*DQA + DQB, IR0 = MAC0/1000h (saturates 0..+1000h).
      this.setMac0(n * this.dqa + this.dqb);
      let ir0 = this.dr[24]! >> 12;
      if (ir0 < 0) {
        ir0 = 0;
        this.cr[CR_FLAG]! |= FLAG_IR0_SAT;
      } else if (ir0 > IR0_MAX) {
        ir0 = IR0_MAX;
        this.cr[CR_FLAG]! |= FLAG_IR0_SAT;
      }
      this.dr[8] = ir0;
    }
  }

  /** NCLIP (no$psx 1400006h): signed area of the SXY FIFO triangle. */
  private nclip(): void {
    const sx0 = s16of(this.dr[12]!, false), sy0 = s16of(this.dr[12]!, true);
    const sx1 = s16of(this.dr[13]!, false), sy1 = s16of(this.dr[13]!, true);
    const sx2 = s16of(this.dr[14]!, false), sy2 = s16of(this.dr[14]!, true);
    this.setMac0(
      sx0 * sy1 + sx1 * sy2 + sx2 * sy0 - sx0 * sy2 - sx1 * sy0 - sx2 * sy1,
    );
  }

  /** MVMVA(sf,mx,v,cv,lm) — no$psx 0400012h. Opcode bit layout (no$psx
   *  "GTE Command Encoding"): bit19 sf, bits17-18 mx (0=RT,1=LLM,2=LCM,
   *  3=garbage), bits15-16 v (0=V0,1=V1,2=V2,3=IR), bits13-14 cv
   *  (0=TR,1=BK,2=FC-bugged,3=None), bit10 lm, bits0-5 command. */
  private mvmva(instr: number): void {
    const sf = (instr & (1 << 19)) !== 0;
    const lm = (instr & (1 << 10)) !== 0;
    const mx = (instr >>> 17) & 3;
    const v = (instr >>> 15) & 3;
    const cv = (instr >>> 13) & 3;
    const shift = sf ? 12 : 0;
    // v=3 selects [IR1,IR2,IR3] instead of a vertex (no$psx vector table).
    const vx = v === 3 ? this.ir1 : this.vec(v as 0 | 1 | 2, 0);
    const vy = v === 3 ? this.ir2 : this.vec(v as 0 | 1 | 2, 1);
    const vz = v === 3 ? this.ir3 : this.vec(v as 0 | 1 | 2, 2);

    const tr = [this.cr[CR_TRX]! | 0, this.cr[CR_TRY]! | 0, this.cr[CR_TRZ]! | 0];
    const bk = [this.cr[CR_RBK]! | 0, this.cr[CR_GBK]! | 0, this.cr[CR_BBK]! | 0];
    const fc = [this.cr[CR_RFC]! | 0, this.cr[CR_GFC]! | 0, this.cr[CR_BFC]! | 0];
    const none = [0, 0, 0];
    const tByCv = [tr, bk, fc, none];

    if (mx === 3) {
      // Garbage matrix (no$psx MVMVA note): -R*10h, +R*10h, IR0,
      // RT13, RT13, RT13, RT22, RT22, RT22 (R = RGBC red byte * 10h).
      const r16 = (this.dr[6]! & 0xff) * 0x10;
      const m = [
        -r16, r16, this.dr[8]!,
        this.mat(CR_RT, 2), this.mat(CR_RT, 2), this.mat(CR_RT, 2),
        this.mat(CR_RT, 4), this.mat(CR_RT, 4), this.mat(CR_RT, 4),
      ];
      for (let row = 0; row < 3; row++) {
        const i = (row + 1) as 1 | 2 | 3;
        const acc = tByCv[cv]![row]! * 4096 + m[row * 3]! * vx + m[row * 3 + 1]! * vy + m[row * 3 + 2]! * vz;
        this.setMac(i, acc, shift);
        this.setIr(i, this.dr[24 + i]!, lm);
      }
      return;
    }

    const matBase = [CR_RT, CR_LLM, CR_LCM][mx]!;

    if (cv === 2) {
      // Hardware bug (no$psx MVMVA note; DuckStation MulMatVecBuggy): the
      // FC translation is dropped from the stored result — per row, IR gets
      // (T*1000h + M_i1*Vx) SAR 12 with lm=0-style flags, then MAC/IR get
      // (M_i2*Vy + M_i3*Vz) SAR (sf*12) with the real lm. FLAG activity
      // partially continues "as if the full operation executed" per spec.
      for (let row = 0; row < 3; row++) {
        const i = (row + 1) as 1 | 2 | 3;
        const e = row * 3;
        const first = fc[row]! * 4096 + this.mat(matBase, e) * vx;
        this.macOverflowFlags(i, first);
        this.setIr(i, sarShift(first, 12), false);
        const rest = this.mat(matBase, e + 1) * vy + this.mat(matBase, e + 2) * vz;
        this.setMac(i, rest, shift);
        this.setIr(i, this.dr[24 + i]!, lm);
      }
      return;
    }

    this.storeRow(this.rowDots(matBase, tByCv[cv]!, vx, vy, vz), sf, lm);
  }

  /**
   * NCDS body (no$psx 0E80413h): (LLM*V) then (BK*1000h + LCM*IR), then
   * [R*IR1,G*IR2,B*IR3] SHL 4, depth-cue interpolation toward FC, and the
   * color FIFO push.
   */
  private ncdsCore(vx: number, vy: number, vz: number, sf: boolean, lm: boolean): void {
    const shift = sf ? 12 : 0;
    const zero = [0, 0, 0];
    this.storeRow(this.rowDots(CR_LLM, zero, vx, vy, vz), sf, lm);
    const bk = [this.cr[CR_RBK]! | 0, this.cr[CR_GBK]! | 0, this.cr[CR_BBK]! | 0];
    this.storeRow(this.rowDots(CR_LCM, bk, this.ir1, this.ir2, this.ir3), sf, lm);

    // MAC = [R*IR1, G*IR2, B*IR3] SHL 4 — bounded by 2^27, no overflow.
    const rgb = this.dr[6]!;
    const inMac = [
      (rgb & 0xff) * this.ir1 * 16,
      ((rgb >>> 8) & 0xff) * this.ir2 * 16,
      ((rgb >>> 16) & 0xff) * this.ir3 * 16,
    ];
    this.dr[25] = sat32(inMac[0]!);
    this.dr[26] = sat32(inMac[1]!);
    this.dr[27] = sat32(inMac[2]!);
    this.interpolateColor(inMac, sf, lm);
    // Color FIFO = [MAC1/16,...]; the interpolateColor tail already left
    // IR1..3 = MAC1..3 saturated (its second setIr), satisfying the final
    // "[IR1,IR2,IR3] = [MAC1,MAC2,MAC3]" of the no$psx formula.
    this.pushRgbFromMac();
  }

  /** AVSZ3/AVSZ4: OTZ = ZSF * sum of the last three/four Z FIFO entries. */
  private avsz(count: 3 | 4): void {
    let sum = 0;
    for (let i = 20 - count; i < 20; i++) sum += this.dr[i]! & 0xffff;
    const zsf = count === 3 ? this.cr[CR_ZSF3]! : this.cr[CR_ZSF4]!;
    let value = sum * zsf;
    this.setMac0(value);
    if (value < 0) {
      value = 0;
      this.cr[CR_FLAG]! |= FLAG_SZ_OTZ_SAT;
    } else if (value > 0xffff) {
      value = 0xffff;
      this.cr[CR_FLAG]! |= FLAG_SZ_OTZ_SAT;
    }
    this.dr[7] = value;
  }

  /** SQR(sf) — no$psx 0A00428h: MAC = IR² SHR (sf*12); IR = MAC saturated
   *  to max +7FFFh (result is always ≥ 0, so lm has no effect). */
  private sqr(sf: boolean, lm: boolean): void {
    const shift = sf ? 12 : 0;
    this.setMac(1, this.ir1 * this.ir1, shift);
    this.setMac(2, this.ir2 * this.ir2, shift);
    this.setMac(3, this.ir3 * this.ir3, shift);
    this.setIr(1, this.dr[25]!, lm);
    this.setIr(2, this.dr[26]!, lm);
    this.setIr(3, this.dr[27]!, lm);
  }

  /**
   * OP(sf,lm) — no$psx "COP2 170000Ch" (real opcode 0Ch, fake bits 17h):
   * cross product with D1,D2,D3 = RT11,RT22,RT33 of the rotation matrix
   * "misused" as a vector.
   */
  private op(sf: boolean, lm: boolean): void {
    const shift = sf ? 12 : 0;
    const d1 = this.mat(CR_RT, 0);
    const d2 = this.mat(CR_RT, 4);
    const d3 = this.mat(CR_RT, 8);
    const ir1 = this.ir1, ir2 = this.ir2, ir3 = this.ir3;
    this.setMac(1, ir3 * d2 - ir2 * d3, shift);
    this.setMac(2, ir1 * d3 - ir3 * d1, shift);
    this.setMac(3, ir2 * d1 - ir1 * d2, shift);
    this.setIr(1, this.dr[25]!, lm);
    this.setIr(2, this.dr[26]!, lm);
    this.setIr(3, this.dr[27]!, lm);
  }

  /**
   * Execute one COP2 command (raw 25-bit opcode). Real opcodes per no$psx
   * "GTE Command Summary (sorted by Real Opcode bits)":
   *   01h RTPS, 06h NCLIP, 0Ch OP, 12h MVMVA, 13h NCDS, 16h NCDT,
   *   28h SQR, 30h RTPT.
   * The ticket's numbers for RTPT/NCDS/SQR/OP (06h/0Eh/2Ah/17h) collide
   * with different real commands (06h=NCLIP, 17h=N/A) or N/A slots; the
   * spec codes are authoritative. NCDT (16h) is implemented as the NCDS
   * sequence over V0,V1,V2 (the ticket's "0x16 NCDS-only variant").
   */
  execute(instr: number): void {
    const cmd = instr & 0x3f;
    const sf = (instr & (1 << 19)) !== 0;
    const lm = (instr & (1 << 10)) !== 0;

    this.clearFlag();

    switch (cmd) {
      case 0x01: // RTPS
        this.rtps(this.v[0]!, this.v[1]!, this.v[2]!, sf, lm, true);
        break;

      case 0x06: // NCLIP
        this.nclip();
        break;

      case 0x12: // MVMVA
        this.mvmva(instr);
        break;

      case 0x13: // NCDS
        this.ncdsCore(this.v[0]!, this.v[1]!, this.v[2]!, sf, lm);
        break;

      case 0x16: // NCDT = NCDS over V0, V1, V2 (no$psx 0F80416h)
        this.ncdsCore(this.v[0]!, this.v[1]!, this.v[2]!, sf, lm);
        this.ncdsCore(this.v[3]!, this.v[4]!, this.v[5]!, sf, lm);
        this.ncdsCore(this.vx2, this.vy2, this.vz2, sf, lm);
        break;

      case 0x17: // N/A in the real opcode table (17h is OP only in the
        // fake-opcode list); real OP command is bits 0-5 = 0Ch.
        break;

      case 0x0c: // OP(sf,lm) — real opcode 0Ch (no$psx "0Ch OP(sf) 6")
        this.op(sf, lm);
        break;

      case 0x28: // SQR(sf)
        this.sqr(sf, lm);
        break;

      case 0x2d: this.avsz(3); break;
      case 0x2e: this.avsz(4); break;

      case 0x30: // RTPT = RTPS over V0, V1, V2 (no$psx 0280030h)
        this.rtps(this.v[0]!, this.v[1]!, this.v[2]!, sf, lm, false);
        this.rtps(this.v[3]!, this.v[4]!, this.v[5]!, sf, lm, false);
        this.rtps(this.vx2, this.vy2, this.vz2, sf, lm, true);
        break;

      default:
        // Unknown opcodes: no$psx marks them N/A; FLAG stays cleared.
        break;
    }

    this.updateErrorBit();
  }
}
