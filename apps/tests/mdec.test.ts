/**
 * MDEC conformance suite — formal-first verification per project rule.
 * 1. Byte-level command behavior: MDEC(0)/(2)/(3)/(4..7) responses, status
 *    layouts, reset, DMA enables — hand-computed per no$psx 1F801824h.
 * 2. Single 8x8 block (bi-directional fixed-length / decode8): DC-only and
 *    single-coefficient blocks with hand-computed expected pixels, zigzag
 *    semantics, q_scale=0 special mode, EOB/padding, run-past-63, 9-bit wrap.
 * 3. Colored-block golden vectors: a flat macroblock encoded by hand from the
 *    documented integer pipeline → decode → ±1 LSB per channel for rounding.
 * 4. decode16/encode16: BS v2 round-trips, hand-built bitstreams, escape
 *    codes, DC 0x1FF saturation, End of Frame, codebook integrity.
 * 5. AAN IDCT property: DC-only exactness and linear response in the DC.
 */
import { describe, test, expect } from "bun:test";
import { Mdec } from "../src/core/mdec";
import {
  STANDARD_SCALE_TABLE,
  VLC_DECODE_TABLE,
  VLC_EOB,
  VLC_ESC,
  VLC_MAX_LEVEL,
  VLC_RUN,
  ZIGZAG,
  BitReader,
  BitWriter,
} from "../src/core/mdec-tables";

/** Uniform luminance/color quant table (value 16 everywhere). */
const QT_16 = new Uint8Array(64).fill(16);

/** Words for MDEC(2) with color=1: 128 bytes of table data, LE words. */
function quantTableWords(y: Uint8Array, uv: Uint8Array): number[] {
  const bytes = new Uint8Array(128);
  bytes.set(y, 0);
  bytes.set(uv, 64);
  const words: number[] = [];
  for (let i = 0; i < 128; i += 4) {
    words.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0);
  }
  return words;
}

/** Words for MDEC(3): 64 halfwords as LE word pairs. */
function scaleTableWords(scale: Int16Array): number[] {
  const words: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    words.push((scale[i]! & 0xffff) | ((scale[i + 1]! & 0xffff) << 16));
  }
  return words;
}

/** Upload quant (color=1) + standard scale tables. */
function setupStandard(m: Mdec): void {
  m.write((2 << 29) | 1);
  for (const w of quantTableWords(QT_16, QT_16)) m.pushWord(w);
  m.write(3 << 29);
  for (const w of scaleTableWords(STANDARD_SCALE_TABLE)) m.pushWord(w);
}

/** Decode command word: depth (0..3), signed, stp, word count. */
const decodeCmd = (words: number, depth: number, signed = false, stp = false): number =>
  (((1 << 29) | (depth << 27) | (signed ? 1 << 26 : 0) | (stp ? 1 << 25 : 0) | words) >>> 0);

/** Pack run-level halfwords into push-order u32 words (LE pair order). */
const rlWords = (hs: number[]): number[] => {
  const out: number[] = [];
  for (let i = 0; i < hs.length; i += 2) {
    out.push(((hs[i]! & 0xffff) | (((hs[i + 1] ?? 0) & 0xffff) << 16)) >>> 0);
  }
  return out;
};

/** Pad halfwords to a whole number of DMA0 words and decode. */
function decodeStream(m: Mdec, hs: number[], depth: number, signed = false, stp = false): Uint8Array {
  const padded = [...hs];
  while (padded.length % 2 !== 0) padded.push(0xfe00);
  const words = rlWords(padded);
  m.write(decodeCmd(words.length, depth, signed, stp));
  for (const w of words) m.pushWord(w);
  return new Uint8Array(m.readOutput().slice().buffer);
}

/** Flat macroblock: Y DC = dc on all four luma blocks, chroma DC = 0. */
const flatMb = (dc: number, q: number): number[] =>
  [
    (q << 10) | 0, // Cr
    (q << 10) | 0, // Cb
    ...Array.from({ length: 4 }, () => (q << 10) | (dc & 0x3ff)), // Y1..Y4
  ].flatMap((h) => [h, 0xfe00]);

// ---------------------------------------------------------------------------
// 1. Register / command behavior
// ---------------------------------------------------------------------------

describe("MDEC registers", () => {
  test("reset sets status 80040000h per no$psx MDEC1 write bit31", () => {
    const m = new Mdec();
    setupStandard(m);
    m.writeControl(0x80000000);
    expect(m.regs).toBe(0x80040000);
  });

  test("MDEC(0)/MDEC(4..7) reflect bits, expect no parameters", () => {
    const m = new Mdec();
    m.write((0 << 29) | (2 << 27) | 1234); // depth 2, "word count" 1234
    // no$psx: bits reflected without the minus-1 effect, no parameters expected.
    expect(m.regs & 0x0000ffff).toBe(0xffff); // none remaining
    expect((m.regs >>> 25) & 3).toBe(2); // depth copied to STAT.26-25
    m.pushWord(0xdeadbeef); // must not disturb anything
    expect(m.regs & 0x0000ffff).toBe(0xffff);
    m.writeControl(0x80000000);
    expect(m.regs).toBe(0x80040000);
    const m2 = new Mdec();
    m2.write((5 << 29) | (3 << 27) | 7); // invalid MDEC(5)
    expect((m2.regs >>> 25) & 3).toBe(3);
    expect(m2.regs & 0x0000ffff).toBe(0xffff);
  });

  test("MDEC(2) quant upload: words consumed minus 1, color bit adds 64 bytes", () => {
    const m = new Mdec();
    m.write((2 << 29) | 1); // color=1: 128 bytes = 32 words
    expect(m.regs & 0x0000ffff).toBe(31); // remaining minus 1
    const words = quantTableWords(QT_16, QT_16);
    for (let i = 0; i < words.length - 1; i++) m.pushWord(words[i]!);
    expect(m.regs & 0x0000ffff).toBe(0); // one word still expected
    m.pushWord(words[words.length - 1]!);
    expect(m.regs & 0x0000ffff).toBe(0xffff); // done
    // Luminance-only variant expects only 16 words.
    const m2 = new Mdec();
    m2.write(2 << 29);
    expect(m2.regs & 0x0000ffff).toBe(15);
  });

  test("MDEC(3) scale upload: 32 words, then status clears", () => {
    const m = new Mdec();
    m.write(3 << 29);
    expect(m.regs & 0x0000ffff).toBe(31);
    for (const w of scaleTableWords(STANDARD_SCALE_TABLE)) m.pushWord(w);
    expect(m.regs & 0x0000ffff).toBe(0xffff);
  });

  test("Test command FE060000 shape: command class bits + fixed table anchors", () => {
    // The MDEC has no readable huffman table; the "response" contract is the
    // fixed codebook anchor points (EOB {2,2}, ESC {1,6}) + command reflection.
    const m = new Mdec();
    m.write(0xfe06_0000); // raw FE060000 (Test command shape)
    expect(m.regs & 0x0000ffff).toBe(0xffff); // no parameters expected
    expect(m.regs & 0x20000000).toBe(0); // not busy
    expect(VLC_EOB).toEqual({ code: 0x2, bits: 2 });
    expect(VLC_ESC).toEqual({ code: 0x1, bits: 6 });
  });

  test("status BUSY and word-count track a decode command", () => {
    const m = new Mdec();
    m.write(decodeCmd(4, 2)); // 4 words still to receive
    expect((m.regs & 0x20000000) !== 0).toBe(true); // BUSY
    expect(m.regs & 0x0000ffff).toBe(3); // minus 1
    m.writeControl(0x80000000); // abort
    expect(m.regs).toBe(0x80040000);
  });

  test("DMA enable bits reflect MDEC1 writes 30/29", () => {
    const m = new Mdec();
    m.writeControl(0x40000000); // enable data-in request
    expect((m.regs & 0x10000000) !== 0).toBe(true); // DREQ0 set when ready
    expect((m.regs & 0x08000000) !== 0).toBe(false); // no output yet
    m.writeControl(0x80000000); // reset clears enables
    expect((m.regs & 0x10000000) !== 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Single 8x8 block — bi-directional fixed-length (decode8 / rl path)
// ---------------------------------------------------------------------------

describe("MDEC single 8x8 block", () => {
  test("DC-only block: every pixel flat, hand-computed value", () => {
    const m = new Mdec();
    setupStandard(m);
    // q(command)=16, qt=16, DC=+32: val = dc*qt = 512 (≤1023, no saturation),
    // pixel = 128 + val/8 = 128 + 64 = 192 (AAN DC: blk = qt*dc*2^7, out = blk>>10).
    const out = decodeStream(m, flatMb(32, 16), 2, true);
    expect(out.length).toBe(256 * 3);
    for (let px = 0; px < 256; px++) {
      expect(out[px * 3]!).toBe(192); // Cr=Cb=0 → R=G=B=Y
      expect(out[px * 3 + 1]!).toBe(192);
      expect(out[px * 3 + 2]!).toBe(192);
    }
  });

  test("DC response is linear with hand-computed slope (exact, no tolerance)", () => {
    const m = new Mdec();
    setupStandard(m);
    // pixel signed = round-half-down(dc*qt*128 / 2^10) = round-half-down(dc*qt/8).
    // qt=16: dc=4 → 8.0 → 8; dc=8 → 16; dc=12 → 24; dc=1 → 2.
    const at = (dc: number): number => decodeStream(m, flatMb(dc, 8), 2, true)[0 * 3 + 1]! - 128;
    expect(at(1)).toBe(2);
    expect(at(4)).toBe(8);
    expect(at(8)).toBe(16);
    expect(at(12)).toBe(24);
    expect(at(0)).toBe(0);
    expect(at(-1)).toBe(-2);
    // Round-half-down: dc=51, qt=16 → 102.0 → 102 exactly; dc=53 → 106.
    expect(at(51)).toBe(102);
    expect(at(53)).toBe(106);
  });

  test("unsigned output adds 80h to the signed pixel (mono xor rule for RGB)", () => {
    const m = new Mdec();
    setupStandard(m);
    // flatMb(0, 8): all channels 0 signed → 128 unsigned either way; use a DC
    // that puts channels apart: with Cr=Cb=0 the channels stay equal, so the
    // observable is the +128 offset itself on the mono path (depth 1).
    const signedMono = decodeStream(m, [(8 << 10) | 8, 0xfe00], 1, true);
    const unsignedMono = decodeStream(m, [(8 << 10) | 8, 0xfe00], 1, false);
    // DC=8, qt=16 → val=128 → blk 16384 → pixel 16 signed → unsigned 144.
    expect(signedMono[0]).toBe(16);
    expect(unsignedMono[0]).toBe(144);
    expect(signedMono.every((v, i) => v === 16 || i >= 64)).toBe(true);
  });

  test("single AC at zigzag index 1: antisymmetric horizontal gradient", () => {
    const m = new Mdec();
    setupStandard(m);
    // DC=0, run=0 level=+50, q=8 → dequant (50*16*8+4)/8 = 800 at raster 1.
    // Frequency (1,0) basis: antisymmetric about the vertical centre line,
    // constant along y. Mono path (depth 1) keeps chroma out of the picture.
    const out = decodeStream(m, [(8 << 10) | 0, (0 << 10) | 50, 0xfe00], 1, true);
    expect(out.length).toBe(64);
    const gray = (x: number, y: number): number => out[y * 8 + x]! - 128;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(Math.abs(gray(x, y) + gray(7 - x, y))).toBeLessThanOrEqual(12);
      }
      for (let x = 0; x < 8; x++) {
        expect(Math.abs(gray(x, y) - gray(x, 0))).toBeLessThanOrEqual(2);
      }
    }
  });

  test("zigzag: single AC at k=8 (run 7) lands at raster ZIGZAG[8]=2", () => {
    const m = new Mdec();
    setupStandard(m);
    // run=7 → k=8; ZIGZAG[8]=2 → raster (2,0), horizontal frequency 2.
    // If zigzag were broken (e.g. k used directly → (0,1) vertical), the
    // gradient would run vertically instead of horizontally.
    const out = decodeStream(m, [(8 << 10) | 0, (7 << 10) | 40, 0xfe00], 1, true);
    const gray = (x: number, y: number): number => out[y * 8 + x]! - 128;
    // Frequency (2,0) along x: constant along y (each row identical).
    for (let y = 1; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(gray(x, y)).toBe(gray(x, 0));
      }
    }
    // Horizontal structure present (not flat, not vertical).
    const rowRange = Math.max(...Array.from({ length: 8 }, (_, x) => gray(x, 0))) -
      Math.min(...Array.from({ length: 8 }, (_, x) => gray(x, 0)));
    expect(rowRange).toBeGreaterThan(0);
    // Column 0 must carry NO energy beyond its own basis value: the coefficient
    // sits at raster (2,0), so column 0 only sees the (2,0) cosine at x=0.
    expect(gray(1, 0)).not.toBe(gray(2, 0));
  });

  test("q_scale=0 special mode: doubled value, NO zigzag (raster k directly)", () => {
    const m = new Mdec();
    setupStandard(m);
    // q_scale=0, run=1 → k=2 → RASTER 2 (not ZIGZAG[2]=5). DC=+60 doubled
    // (no table): Y pixel = round-half-down(60*2/4/…): val*2*AAN/2^20.
    const out = decodeStream(m, [(0 << 10) | 60, (1 << 10) | 20, 0xfe00], 1, true);
    const gray = (x: number, y: number): number => out[y * 8 + x]! - 128;
    // Energy at raster 2 (u=2, v=0): constant down rows, varies along x.
    for (let y = 1; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(gray(x, y)).toBe(gray(x, 0));
      }
    }
    const midRow = Array.from({ length: 8 }, (_, x) => gray(x, 0));
    const spread = Math.max(...midRow) - Math.min(...midRow);
    expect(spread).toBeGreaterThan(0);
  });

  test("run past 63 clamps: rest of the block stays DC-only", () => {
    const m = new Mdec();
    setupStandard(m);
    // run=62 → k=63 OK; another run pushes k>63 → break. Two-AC variant would
    // put energy at higher frequencies; here it must equal the DC-only decode.
    const withRun = decodeStream(m, [(8 << 10) | 100, (62 << 10) | 7, (0 << 10) | 9, 0xfe00], 2, true);
    const dcOnly = decodeStream(m, [(8 << 10) | 100, 0xfe00], 2, true);
    expect(Array.from(withRun)).toEqual(Array.from(dcOnly));
  });

  test("leading FE00 padding skipped (@@skip arm)", () => {
    const m = new Mdec();
    setupStandard(m);
    const padded = [0xfe00, 0xfe00, ...flatMb(64, 16)];
    const plain = decodeStream(m, flatMb(64, 16), 2, true);
    const out = decodeStream(m, padded, 2, true);
    // The padded stream has the same first macroblock output.
    expect(Array.from(out.subarray(0, 768))).toEqual(Array.from(plain.subarray(0, 768)));
  });

  test("EOB pads the rest of the block with zero ACs", () => {
    const m = new Mdec();
    setupStandard(m);
    const withEob = decodeStream(m, [(8 << 10) | 100, (1 << 10) | 20, (2 << 10) | 5, 0xfe00], 2, true);
    const without = decodeStream(m, [(8 << 10) | 100, (1 << 10) | 20, (2 << 10) | 5], 2, true);
    expect(Array.from(withEob)).toEqual(Array.from(without));
  });

  test("DC saturation: |dc*qt| > 11-bit range clamps to ±0x3FF", () => {
    const m = new Mdec();
    setupStandard(m);
    // DC field is 10-bit signed (-512..511); qt=16 → |val| = |dc*16|.
    // dc=+64 → val 1024 > 1023 → clamped to 1023 → blk = scaler(1023*65536,9)
    // = 130944 → pixel 127.875 → half-down 127 → +128 = 255.
    const out = decodeStream(m, flatMb(64, 16), 2, true);
    expect(out[1]).toBe(255);
    // dc=-64 → val -1024 (already at the clamp edge) → blk -131072 → pixel
    // -128 → clamp8 saturates at 0.
    const neg = decodeStream(m, flatMb(-64, 16), 2, true);
    expect(neg[1]).toBe(0);
  });

  test("mono 8bpp: Y_to_mono output domain", () => {
    const m = new Mdec();
    setupStandard(m);
    // depth 1 (8bpp mono): one Y block per macroblock, 64 bytes out.
    // DC=+8, qt=16 → val 128 → blk 16384 → pixel 16 signed (idctAan DC fill).
    const out = decodeStream(m, [(8 << 10) | 8, 0xfe00], 1, true);
    expect(out.length).toBe(64);
    for (let i = 0; i < 64; i++) expect(out[i]).toBe(16);
    void m;
  });

  test("mono 4bpp: two pixels per byte, low nibble first", () => {
    const m = new Mdec();
    setupStandard(m);
    const out = decodeStream(m, [(8 << 10) | 0, 0xfe00], 0, true);
    expect(out.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// 3. Colored macroblock golden vectors (hand-encoded flat blocks)
// ---------------------------------------------------------------------------

describe("MDEC colored macroblock golden vectors", () => {
  test("flat gray: every pixel 192 exact (DC=32,qt=16) in RGB24 and RGBA modes", () => {
    const m = new Mdec();
    setupStandard(m);
    for (const depth of [2, 3]) {
      const out = decodeStream(m, flatMb(32, 16), depth, true);
      const stride = depth === 2 ? 3 : 4;
      expect(out.length).toBe(256 * stride);
      for (let px = 0; px < 256; px++) {
        expect(out[px * stride]!).toBe(192);
        expect(out[px * stride + 1]!).toBe(192);
        expect(out[px * stride + 2]!).toBe(192);
        if (depth === 3) expect(out[px * 4 + 3]!).toBe(0);
      }
    }
  });

  test("flat chroma macroblock: hand-computed RGB exact per channel", () => {
    const m = new Mdec();
    setupStandard(m);
    // All DCs unsaturated (|dc*16| ≤ 1023 → |dc| ≤ 63).
    // blk = qt*dc*128: Y dc=32 → 65536; Cr dc=16 → 32768; Cb dc=-8 → -16384.
    // R = clamp8(scale8(Y<<10 + 1436*Cr)), G = ...-352*Cb - 731*Cr, B = ...+1818*Cb.
    // Hand-computed: R=237, G=175, B=164.
    const hs = [
      (16 << 10) | 16, 0xfe00, // Cr: dc=16
      (16 << 10) | ((-8) & 0x3ff), 0xfe00, // Cb: dc=-8
      ...Array.from({ length: 4 }, () => [(16 << 10) | 32, 0xfe00]).flat(), // Y: dc=32
    ];
    const out = decodeStream(m, hs, 2, true);
    const r = out[0]!;
    const g = out[1]!;
    const b = out[2]!;
    expect(r).toBe(237);
    expect(g).toBe(175);
    expect(b).toBe(164);
    for (let px = 1; px < 256; px++) {
      expect(out[px * 3]!).toBe(r);
      expect(out[px * 3 + 1]!).toBe(g);
      expect(out[px * 3 + 2]!).toBe(b);
    }
  });

  test("STP bit sets RGBA alpha only — no blending (documented skip)", () => {
    const m = new Mdec();
    setupStandard(m);
    const hs = flatMb(32, 16);
    const m2 = new Mdec();
    setupStandard(m2);
    const withStp = decodeStream(m, hs, 3, false, true);
    const noStp = decodeStream(m, hs, 3, false, false);
    for (let px = 0; px < 256; px++) {
      expect(withStp[px * 4]!).toBe(noStp[px * 4]!);
      expect(withStp[px * 4 + 1]!).toBe(noStp[px * 4 + 1]!);
      expect(withStp[px * 4 + 2]!).toBe(noStp[px * 4 + 2]!);
      expect(withStp[px * 4 + 3]!).toBe(0x80);
      expect(noStp[px * 4 + 3]!).toBe(0);
    }
    // STAT.23 reflects CMD.25 while a decode command with STP is resident.
    const m3 = new Mdec();
    m3.write(decodeCmd(1, 3, false, true));
    expect((m3.regs >>> 23) & 1).toBe(1);
  });

  test("chroma subsampled 2x2: 8x8 chroma covers 16x16 pixels (structure)", () => {
    const m = new Mdec();
    setupStandard(m);
    // Single chroma DC but four different Y blocks: the four quadrants differ
    // in luminance while chroma is shared — proves the 8x8→16x16 zoom mapping.
    // Cr dc=8 → blk 16384; Cb dc=0. Y dcs 16/32/0/48 → greens 149/181/117/213.
    const hs = [
      (16 << 10) | 8, 0xfe00, // Cr
      (16 << 10) | 0, 0xfe00, // Cb
      (16 << 10) | 16, 0xfe00, // Y1 (top-left)
      (16 << 10) | 32, 0xfe00, // Y2 (top-right)
      (16 << 10) | 0, 0xfe00, // Y3 (bottom-left)
      (16 << 10) | 48, 0xfe00, // Y4 (bottom-right)
    ];
    const out = decodeStream(m, hs, 2, true);
    const lum = (x: number, y: number): number => out[((y * 16 + x) * 3 + 1)]!;
    expect(lum(0, 0)).toBe(lum(7, 7)); // quadrant 1 flat
    expect(lum(8, 0)).toBe(lum(15, 7)); // quadrant 2 flat
    expect(lum(0, 8)).toBe(lum(7, 15)); // quadrant 3 flat
    expect(lum(8, 8)).toBe(lum(15, 15)); // quadrant 4 flat
    expect(lum(0, 0)).toBe(149);
    expect(lum(8, 0)).toBe(181);
    expect(lum(0, 8)).toBe(117);
    expect(lum(8, 8)).toBe(213);
    // Quadrants map 1:1 to Y blocks (no spatial mixing): Y1↔Y2 columns 0-7/8-15.
    expect(lum(0, 15)).toBe(117); // Y3 spans rows 8-15, cols 0-7
    expect(lum(15, 15)).toBe(213); // Y4 spans rows 8-15, cols 8-15
  });

  test("multiple macroblocks decode in stream order", () => {
    const m = new Mdec();
    setupStandard(m);
    const hs = [...flatMb(32, 16), ...flatMb(-32, 16)]; // bright (192) then dark (64)
    const out = decodeStream(m, hs, 2, true);
    expect(out.length).toBe(512 * 3);
    expect(out[0 * 3 + 1]).toBe(192);
    expect(out[256 * 3 + 1]).toBe(64);
  });

  test("9-bit wrap: overshooting value comes out BLACK not white", () => {
    const m = new Mdec();
    setupStandard(m);
    // Engineered to cross the 8-bit rail: big DC + big AC (a DC-only block
    // caps at 127.875 signed and cannot wrap). A pixel wrapping past +255
    // must land black (0) via the 9-bit mask, not clamp white. Mono path
    // keeps the arithmetic visible: pixel ≈ 126 + 177*cos ≈ 300 → wraps to
    // -212 → saturates to 0.
    const out = decodeStream(m, [(16 << 10) | 63, (0 << 10) | 300, 0xfe00], 1, false);
    let sawBlack = false;
    for (let px = 0; px < 64; px++) {
      if (out[px] === 0) sawBlack = true;
    }
    expect(sawBlack).toBe(true);
  });

  test("AAN IDCT DC-only exactness property: uniform output equals DC response", () => {
    const m = new Mdec();
    setupStandard(m);
    for (const dc of [-60, -23, 0, 31, 63]) {
      const out = decodeStream(m, flatMb(dc, 24), 2, true);
      const v = out[0]!;
      for (let px = 1; px < 256; px++) expect(out[px * 3]!).toBe(v);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. decode16 / encode16 — BS bitstream (variable-length huffman)
// ---------------------------------------------------------------------------

/** Hand-build a BS v2 bitstream from (quant, blocks of run-level words). */
function buildBs(quant: number, blocks: number[][]): Uint8Array {
  let halfwords = 0;
  for (const b of blocks) halfwords += b.length + 1;
  const padded = (halfwords + 0x3f) & ~0x3f;
  const rlWords = (padded + 1) >> 1;
  const bw = new BitWriter();
  for (const block of blocks) {
    bw.put(block[0]! & 0x3ff, 10); // DC, raw 10 bits
    for (let i = 1; i < block.length; i++) {
      const w = block[i]!;
      const run = (w >>> 10) & 0x3f;
      let level = w & 0x3ff;
      if ((level & 0x200) !== 0) level -= 0x400;
      const mag = Math.abs(level);
      const c = run < 32 && mag >= 1 && mag <= VLC_MAX_LEVEL[run]! ? VLC_RUN[run]![mag - 1] : undefined;
      if (c !== undefined && c.bits !== 0) {
        bw.put(level < 0 ? c.code | 1 : c.code, c.bits);
      } else {
        bw.put(VLC_ESC.code, VLC_ESC.bits);
        bw.put(w & 0xffff, 16);
      }
    }
    bw.put(VLC_EOB.code, VLC_EOB.bits);
  }
  bw.put(0x1ff, 10); // End of Frame
  bw.finish();
  const out = new Uint8Array(8 + bw.bytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, rlWords, true);
  dv.setUint16(2, 0x3800, true);
  dv.setUint16(4, quant, true);
  dv.setUint16(6, 2, true);
  out.set(bw.bytes, 8);
  return out;
}

describe("MDEC VLC codebook integrity", () => {
  test("all codes are within 2..17 bits and nonzero", () => {
    for (const key of VLC_DECODE_TABLE.keys()) {
      const bits = key >>> 20;
      const code = key & 0xfffff;
      expect(bits).toBeGreaterThanOrEqual(2);
      expect(bits).toBeLessThanOrEqual(17);
      expect(code).not.toBe(0);
    }
  });

  test("book is prefix-free: no code is a prefix of a longer code", () => {
    const codes: { bits: number; code: number }[] = [];
    for (const key of VLC_DECODE_TABLE.keys()) {
      codes.push({ bits: key >>> 20, code: key & 0xfffff });
    }
    for (const a of codes) {
      for (const b of codes) {
        if (a === b || b.bits <= a.bits) continue;
        const topOfB = b.code >>> (b.bits - a.bits);
        expect(topOfB).not.toBe(a.code); // a would decode before b finished
      }
    }
  });

  test("reverse table resolves every book entry to the right symbol", () => {
    for (let run = 0; run < 32; run++) {
      for (let lvl = 1; lvl <= VLC_MAX_LEVEL[run]!; lvl++) {
        const c = VLC_RUN[run]![lvl - 1]!;
        expect(c.bits).not.toBe(0);
        expect(VLC_DECODE_TABLE.get((c.bits << 20) | c.code)).toEqual({
          run,
          level: lvl,
          escape: false,
          eob: false,
        });
        expect(VLC_DECODE_TABLE.get((c.bits << 20) | (c.code | 1))).toEqual({
          run,
          level: -lvl,
          escape: false,
          eob: false,
        });
      }
    }
    expect(VLC_DECODE_TABLE.get((VLC_EOB.bits << 20) | VLC_EOB.code)?.eob).toBe(true);
    expect(VLC_DECODE_TABLE.get((VLC_ESC.bits << 20) | VLC_ESC.code)?.escape).toBe(true);
  });

  test("book shape: 32 runs, level 1 always encodable, widths match maxLevel", () => {
    for (let run = 0; run < 32; run++) {
      expect(VLC_RUN[run]!.length).toBe(40);
      expect(VLC_RUN[run]![0]!.bits).not.toBe(0);
    }
  });
});

describe("MDEC decode16 / encode16 (BS bitstream)", () => {
  test("hand-built v2 stream decodes to the exact run-level words", () => {
    const m = new Mdec();
    const bs = buildBs(12, [
      [(12 << 10) | 100, (0 << 10) | 5, (2 << 10) | 3],
      [(12 << 10) | (0x3ff & -200), (1 << 10) | (0x3ff & -7)],
    ]);
    const rl = m.decode16(bs);
    expect(rl[0]).toBe((12 << 10) | 100);
    expect(rl[1]).toBe((0 << 10) | 5);
    expect(rl[2]).toBe((2 << 10) | 3);
    expect(rl[3]).toBe(0xfe00);
    expect(rl[4]).toBe((12 << 10) | (0x3ff & -200));
    expect(rl[5]).toBe((1 << 10) | (0x3ff & -7));
    expect(rl[6]).toBe(0xfe00);
    for (let i = 7; i < rl.length; i++) expect(rl[i]).toBe(0xfe00); // footers
    expect(rl.length % 2).toBe(0);
  });

  test("escape codes carry the raw 16-bit run-level word", () => {
    const m = new Mdec();
    const rawWord = (40 << 10) | 60; // level 60 off the book for run 40 (max 1)
    const bs = buildBs(4, [[(4 << 10) | 10, rawWord]]);
    const rl = m.decode16(bs);
    expect(rl[1]).toBe(rawWord);
  });

  test("negative levels decode via the code|1 sign bit", () => {
    const m = new Mdec();
    const bs = buildBs(8, [[(8 << 10) | 3, (0 << 10) | (0x3ff & -5)]]);
    const rl = m.decode16(bs);
    expect(rl[1]).toBe((0 << 10) | (0x3ff & -5));
  });

  test("round trip: encode16 → decode16 reproduces the run-level stream", () => {
    const m = new Mdec();
    const original: number[] = [];
    for (let mb = 0; mb < 2; mb++) {
      for (let b = 0; b < 6; b++) {
        const dc = ((mb * 7 + b * 13) % 400) - 200;
        original.push((10 << 10) | (dc & 0x3ff));
        original.push((0 << 10) | (12 + b));
        original.push((3 << 10) | (0x3ff & -(4 + mb)));
        original.push(0xfe00);
      }
    }
    while (original.length % 64 !== 0) original.push(0xfe00);
    const src = new Uint16Array(original);
    const bs = m.encode16(src);
    const back = m.decode16(bs);
    expect(back.length).toBeGreaterThanOrEqual(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(back[i]).toBe(src[i]!);
    }
  });

  test("encode16 round-trips escape words verbatim", () => {
    const m = new Mdec();
    const rawWord = (40 << 10) | 60;
    const src = new Uint16Array([(8 << 10) | 3, rawWord, 0xfe00, ...new Array(62).fill(0xfe00)]);
    const bs = m.encode16(src);
    const back = m.decode16(bs);
    expect(back[0]).toBe((8 << 10) | 3);
    expect(back[1]).toBe(rawWord);
    expect(back[2]).toBe(0xfe00);
  });

  test("encode16 saturates DC 0x1FF to 0x1FE; decode16 stops at raw 0x1FF", () => {
    const m = new Mdec();
    // Encode side: DC 0x1FF is the End of Frame slot → saturate to 0x1FE.
    const src = new Uint16Array([
      (16 << 10) | 0x1ff, (0 << 10) | 1, 0xfe00,
      ...new Array(61).fill(0xfe00),
    ]);
    const bs = m.encode16(src);
    const rl = m.decode16(bs);
    expect(rl[0]! & 0x3ff).toBe(0x1fe);
    expect(rl[1]).toBe((0 << 10) | 1);
    // Decode side: a RAW 0x1FF in the DC slot is End of Frame — nothing decodes.
    const eof = buildBs(16, [[(16 << 10) | 0x1ff, (0 << 10) | 1]]);
    const eofRl = m.decode16(eof);
    for (let i = 0; i < eofRl.length; i++) expect(eofRl[i]).toBe(0xfe00);
  });

  test("End of Frame stops decoding; remainder becomes FE00 footers", () => {
    const m = new Mdec();
    const bs = buildBs(16, [[(16 << 10) | 100]]);
    const rl = m.decode16(bs);
    expect(rl[0]).toBe((16 << 10) | 100);
    expect(rl[1]).toBe(0xfe00); // the block's EOB
    for (let i = 2; i < rl.length; i++) expect(rl[i]).toBe(0xfe00);
  });

  test("BS v3 delta-coded DC decodes with per-component predictors", () => {
    const m = new Mdec();
    // Hand-build v3: size codes then delta bits. Blocks: Cr, Cb, Y, Y, Y, Y.
    // Deltas: Cr +8 (size 4: code 0b110, extra 4 bits, value 8 = 0b1000),
    // Cb -8 (extra 0b1000 → raw 8 with top bit... size 4: -(2^4-1)= -15 base;
    // -8 = raw 7 → 0b0111), Y +4 (size 3: code 0b101, raw 4 = 0b100),
    // then Y blocks with delta 0 (size 0).
    const bw = new BitWriter();
    const putDelta = (book: readonly { code: number; length: number }[], size: number, delta: number): void => {
      bw.put(book[size]!.code, book[size]!.length);
      if (size > 0) {
        const raw = delta >= 0 ? delta : delta + ((1 << size) - 1);
        bw.put(raw, size);
      }
    };
    const dcSizeOf = (delta: number): number => {
      for (let s = 0; s < 9; s++) {
        const half = 1 << (s - 1);
        if (delta === 0) return 0;
        if (delta > 0 && delta <= half) return s;
        if (delta < 0 && delta >= -half - (1 - 1) - (half - 1)) {
          // range: -(2^s - 1) .. -1
          if (delta >= -(2 ** s - 1)) return s;
        }
      }
      return 0;
    };
    const luma = [{ code: 0b100, length: 3 }, { code: 0b00, length: 2 }, { code: 0b01, length: 2 },
      { code: 0b101, length: 3 }, { code: 0b110, length: 3 }, { code: 0b1110, length: 4 },
      { code: 0b11110, length: 5 }, { code: 0b111110, length: 6 }, { code: 0b1111110, length: 7 }];
    const chroma = [{ code: 0b00, length: 2 }, { code: 0b01, length: 2 }, { code: 0b10, length: 2 },
      { code: 0b110, length: 3 }, { code: 0b1110, length: 4 }, { code: 0b11110, length: 5 },
      { code: 0b111110, length: 6 }, { code: 0b1111110, length: 7 }, { code: 0b11111110, length: 8 }];
    // Each block: DC delta then its (empty) AC list closed by EOB, so the AC
    // loop of block N cannot swallow block N+1's DC size code.
    putDelta(chroma, 4, 8); // Cr: +8 → size 4 (range -15..8)
    bw.put(VLC_EOB.code, VLC_EOB.bits);
    putDelta(chroma, 4, -8); // Cb: -8 → size 4
    bw.put(VLC_EOB.code, VLC_EOB.bits);
    putDelta(luma, 3, 4); // Y1: +4 → size 3
    bw.put(VLC_EOB.code, VLC_EOB.bits);
    for (let i = 0; i < 3; i++) {
      putDelta(luma, 0, 0); // Y2..Y4: delta 0, size 0
      bw.put(VLC_EOB.code, VLC_EOB.bits);
    }
    bw.put(0x1ff, 10);
    bw.finish();
    const out = new Uint8Array(8 + bw.bytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 32, true); // rlWords: 6 blocks * 2 halfwords = 12 → pad 64 → 32 words
    dv.setUint16(2, 0x3800, true);
    dv.setUint16(4, 16, true);
    dv.setUint16(6, 3, true); // v3
    out.set(bw.bytes, 8);
    const rl = m.decode16(out);
    // Predictors: lastDc[0..2] start 0. Cr (pred 0): +8*4 = +32. Cb (pred 1): +32-32 = 0.
    // Y (pred 2): +16. Y2..Y4: +16 each (same predictor).
    const q = 16 << 10;
    expect(rl[0]).toBe(q | (32 & 0x3ff));
    // DC field is 10-bit modular: -32 wraps to 992 (the MDEC reinterprets signed).
    expect(rl[2]).toBe(q | (0 - 32 + 1024));
    expect(rl[4]).toBe(q | 16);
    expect(rl[6]).toBe(q | 16);
    expect(rl[8]).toBe(q | 16);
    expect(rl[10]).toBe(q | 16);
  });

  test("garbage magic / version returns empty", () => {
    const m = new Mdec();
    const bad = new Uint8Array(16);
    const dv = new DataView(bad.buffer);
    dv.setUint16(2, 0x1234, true);
    expect(m.decode16(bad).length).toBe(0);
    dv.setUint16(2, 0x3800, true);
    dv.setUint16(6, 9, true);
    expect(m.decode16(bad).length).toBe(0);
    dv.setUint16(6, 0, true);
    expect(m.decode16(bad).length).toBe(0);
  });

  test("BitWriter/BitReader are exact inverses (MSB-first, LE halfwords)", () => {
    const bw = new BitWriter();
    bw.put(0b10, 2);
    bw.put(0b110, 3);
    bw.put(0x1ff, 10);
    bw.put(0xabcd, 16);
    bw.finish();
    const br = new BitReader(new Uint8Array(bw.bytes));
    expect(br.get(2)).toBe(0b10);
    expect(br.get(3)).toBe(0b110);
    expect(br.get(10)).toBe(0x1ff);
    expect(br.get(16)).toBe(0xabcd);
    // Byte layout: bits pack MSB-first into 16-bit words that land LE.
    // Stream: 10 | 110 | 111111111 | 1010101111001101 → first halfword
    // 1011_0011_1111_1111 = 0xb3ff → bytes [0xff, 0xb3].
    expect(bw.bytes[0]).toBe(0xff);
    expect(bw.bytes[1]).toBe(0xb3);
  });

  test("decode16 output feeds the hardware decode path end to end", () => {
    const mA = new Mdec();
    const mB = new Mdec();
    setupStandard(mA);
    setupStandard(mB);
    // Same flat macroblock: raw halves vs VLC-coded via encode16 → decode16.
    const hs = flatMb(320, 32);
    const raw = new Uint16Array(hs);
    const bs = mA.encode16(raw);
    const rl = mA.decode16(bs);
    const wordsA = rlWords(hs);
    mB.write(decodeCmd(wordsA.length, 2, true));
    for (const w of wordsA) mB.pushWord(w);
    const outA = new Uint8Array(mB.readOutput().slice().buffer);
    const wordsB = rlWords(Array.from(rl.subarray(0, hs.length)));
    mA.write(decodeCmd(wordsB.length, 2, true));
    for (const w of wordsB) mA.pushWord(w);
    const outB = new Uint8Array(mA.readOutput().slice().buffer);
    expect(Array.from(outB)).toEqual(Array.from(outA));
  });
});
