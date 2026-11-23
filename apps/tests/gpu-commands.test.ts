/**
 * gpu-commands.test.ts — table-driven GP0 decoder verification (no$psx).
 *
 * One table entry per documented GP0 opcode (plus the documented
 * undocumented mirrors games ship with), each with a hand-encoded packet.
 * Every entry asserts BOTH halves of decoding:
 *   1. packet consumption — the exact word count from the no$psx layout
 *      tables (after the last word the decoder is idle: a following
 *      FillVRAM opcode word starts a NEW command rather than being eaten),
 *   2. field decode — vertex/UV/color/texpage/CLUT words land on the right
 *      fields, observable through rasterized VRAM pixels.
 *
 * Layout references (problemkaputt.de/psxspx, same tables at
 * psx-spx.consoledev.net):
 * - GPU Render Polygon Commands (20h..3Fh)
 * - GPU Render Line Commands (40h..5Fh, terminator 55555555h)
 * - GPU Render Rectangle Commands (60h..7Fh)
 * - GPU Memory Transfer Commands (01h, 02h, 80h, A0h, C0h + masking rules)
 * - GPU Render Command Bits (misc) — opcode bit assignment
 * - GPU Rendering Attributes — Texpage/Clut attribute fields
 */
import { describe, expect, test } from "bun:test";
import { Gpu, VRAM_W, VRAM_H } from "../src/core/gpu.ts";

/** BGR555 VRAM word from 5-bit channels. */
const pack5 = (r: number, g: number, b: number): number =>
  (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);

/** Signed 11-bit vertex coordinate field (X bits 0-10, Y bits 16-26). */
const vert = (x: number, y: number): number =>
  (((x & 0x7ff) << 21) >> 21 & 0xffff) | ((((y & 0x7ff) << 21) >> 21) & 0xffff) << 16;

/** 24-bit color word: R bits 0-7, G 8-15, B 16-23 (CcBbGgRrh). */
const rgb = (r: number, g: number, b: number): number =>
  (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);

/** Texcoord+attribute word: U bits 0-7, V 8-15, attribute 16-31. */
const uv = (u: number, v: number, hi = 0): number =>
  (u & 0xff) | ((v & 0xff) << 8) | ((hi & 0xffff) << 16);

const RED = pack5(31, 0, 0);
const GREEN = pack5(0, 31, 0);
const BLUE = pack5(0, 0, 31);
const WHITE = pack5(31, 31, 31);

function getPx(g: Gpu, x: number, y: number): number {
  return g.vram[y * VRAM_W + x]!;
}
function setPx(g: Gpu, x: number, y: number, c: number): void {
  g.vram[y * VRAM_W + x] = c;
}
/** Feed a whole packet word-by-word (same path CPU writes and DMA2 use). */
function send(g: Gpu, words: number[]): void {
  for (const w of words) g.writeGP0(w >>> 0);
}

/**
 * 4bpp texture page 0 at VRAM(0,0): texel (1,0) = palette index 1.
 * CLUT #1 (VRAM X=16): entry 1 = full red. Matches clut attribute = 1.
 */
function installRedTexel(g: Gpu): void {
  g.vram.fill(0);
  setPx(g, 0, 0, 0x0010); // texels [0,1,0,0]
  // CLUT base 16 (attr 1): entries live at vram[16..31]; texel index 1 → vram[17].
  setPx(g, 16, 0, 0x0010); // CLUT[0] unused filler
  setPx(g, 17, 0, 31); // CLUT[1] = red
}

// ---------------------------------------------------------------------------
// POLYGONS 20h..3Fh — word layouts straight from the no$psx tables:
//   mono (20/22/28/2A):         C, V1..Vn                          4/5 words
//   tex  (24-27/2C-2F):         C, V1, UV1+Clut, V2, UV2+Texpage,
//                               V3[, V4, UV4]                      7/9 words
//   shaded (30/32/38/3A):       C1, V1, C2, V2, C3, V3[, C4, V4]   6/8 words
//   shaded tex (34/36/3C/3E):   per vertex C,V,UV                  9/12 words
//     (Clut from vertex 1's UV word, Texpage from vertex 2's UV word)
//   Undocumented (21h/23h/29h/2Bh/31h/33h/39h/3Bh) = same as their twin;
//   raw+shading nonsense (35h/37h/3Dh/3Fh) = 34h-family layout, raw texture.
// ---------------------------------------------------------------------------
interface PolyRow {
  name: string;
  /** Full packet including the command word. */
  words: number[];
  /** Pixel probed after rendering. */
  px: { x: number; y: number };
  /** Exact expected VRAM value (BGR555). */
  want: number;
}

const RED_CMD = rgb(0xf8, 0, 0); // opaque red
const WHITE_CMD = rgb(0xf8, 0xf8, 0xf8);
const TRI = [vert(10, 10), vert(60, 10), vert(10, 60)];
const QUAD = [vert(10, 10), vert(110, 10), vert(110, 110), vert(10, 110)];
const UV0 = uv(0, 0, 1); // texel (0,0), CLUT attr 1
const UV_TEXPAGE = uv(1, 0, 0); // texel (1,0), texpage attr 0 (page 0, 4bpp)
const UV3 = uv(0, 0);

const polyRows: PolyRow[] = [
  {
    name: "GP0(20h) mono tri opaque",
    words: [(0x20 << 24) | RED_CMD, ...TRI],
    px: { x: 20, y: 20 }, want: RED,
  },
  {
    name: "GP0(21h) undocumented mirror of 20h",
    words: [(0x21 << 24) | RED_CMD, ...TRI],
    px: { x: 20, y: 20 }, want: RED,
  },
  {
    name: "GP0(22h) mono tri semi-transparent (B/2+F/2)",
    words: [(0x22 << 24) | RED_CMD, ...TRI],
    px: { x: 20, y: 20 }, want: pack5(15, 0, 0),
  },
  {
    name: "GP0(23h) undocumented mirror of 22h",
    words: [(0x23 << 24) | RED_CMD, ...TRI],
    px: { x: 20, y: 20 }, want: pack5(15, 0, 0),
  },
  {
    name: "GP0(28h) mono quad opaque",
    words: [(0x28 << 24) | RED_CMD, ...QUAD],
    px: { x: 60, y: 80 }, want: RED,
  },
  {
    name: "GP0(29h) undocumented mirror of 28h (Vampire Hunter D)",
    words: [(0x29 << 24) | RED_CMD, ...QUAD],
    px: { x: 60, y: 80 }, want: RED,
  },
  {
    name: "GP0(2Ah) mono quad semi-transparent",
    words: [(0x2a << 24) | RED_CMD, ...QUAD],
    px: { x: 60, y: 80 }, want: pack5(15, 0, 0),
  },
  {
    name: "GP0(2Bh) undocumented mirror of 2Ah",
    words: [(0x2b << 24) | RED_CMD, ...QUAD],
    px: { x: 60, y: 80 }, want: pack5(15, 0, 0),
  },
  // textured, texture-blending (color word modulates the texel)
  {
    name: "GP0(24h) tex tri opaque blended",
    words: [
      (0x24 << 24) | RED_CMD,
      vert(10, 10), UV0, vert(60, 10), UV_TEXPAGE, vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: RED,
  },
  {
    name: "GP0(25h) tex tri opaque RAW (color word ignored)",
    words: [
      (0x25 << 24) | rgb(0, 0, 0), // black — must NOT black out the texel
      vert(10, 10), UV0, vert(60, 10), UV_TEXPAGE, vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: pack5(2, 0, 0), // texel(u≈0)=CLUT[0]=16 → r5=2
  },
  {
    name: "GP0(26h) tex tri semi-transparent blended",
    words: [
      (0x26 << 24) | RED_CMD,
      vert(10, 10), UV0, vert(60, 10), UV_TEXPAGE, vert(10, 60), UV3,
    ],
    // Texel CLUT[0]=16 has no STP bit → drawn opaque despite bit 25 (no$psx:
    // only STP-marked texel pixels are semi-transparent).
    px: { x: 20, y: 20 }, want: RED,
  },
  {
    name: "GP0(27h) tex tri semi-transparent RAW",
    words: [
      (0x27 << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, vert(60, 10), UV_TEXPAGE, vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: pack5(2, 0, 0), // raw texel, no STP → opaque
  },
  {
    name: "GP0(2Ch) tex quad opaque blended",
    words: [
      (0x2c << 24) | RED_CMD,
      vert(10, 10), UV0, vert(110, 10), UV_TEXPAGE, vert(110, 110), UV3,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: RED,
  },
  {
    name: "GP0(2Dh) tex quad opaque RAW",
    words: [
      (0x2d << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, vert(110, 10), UV_TEXPAGE, vert(110, 110), UV3,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(2, 0, 0), // raw texel CLUT[0]=16
  },
  {
    name: "GP0(2Eh) tex quad semi-transparent blended",
    words: [
      (0x2e << 24) | RED_CMD,
      vert(10, 10), UV0, vert(110, 10), UV_TEXPAGE, vert(110, 110), UV3,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: RED, // texel 2 has no STP → opaque (no$psx)
  },
  {
    name: "GP0(2Fh) tex quad semi-transparent RAW",
    words: [
      (0x2f << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, vert(110, 10), UV_TEXPAGE, vert(110, 110), UV3,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(2, 0, 0),
  },
  // shaded: C1 rides the command word; each later vertex has C before V
  {
    name: "GP0(30h) shaded tri opaque (blue/green/blue)",
    words: [
      (0x30 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(60, 10),
      rgb(0, 0, 0xf8), vert(10, 60),
    ],
    px: { x: 20, y: 20 }, want: pack5(0, 6, 24), // gradient toward green edge
  },
  {
    name: "GP0(31h) undocumented mirror of 30h",
    words: [
      (0x31 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(60, 10),
      rgb(0, 0, 0xf8), vert(10, 60),
    ],
    px: { x: 20, y: 20 }, want: pack5(0, 6, 24), // same as 30h
  },
  {
    name: "GP0(32h) shaded tri semi-transparent",
    words: [
      (0x32 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(60, 10),
      rgb(0, 0, 0xf8), vert(10, 60),
    ],
    px: { x: 20, y: 20 }, want: pack5(0, 3, 12),
  },
  {
    name: "GP0(33h) undocumented mirror of 32h",
    words: [
      (0x33 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(60, 10),
      rgb(0, 0, 0xf8), vert(10, 60),
    ],
    px: { x: 20, y: 20 }, want: pack5(0, 3, 12),
  },
  {
    name: "GP0(38h) shaded quad opaque",
    words: [
      (0x38 << 24) | rgb(0, 0xf8, 0),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(110, 10),
      rgb(0xf8, 0, 0), vert(110, 110),
      rgb(0xf8, 0, 0), vert(10, 110),
    ],
    px: { x: 15, y: 15 }, want: pack5(1, 29, 0), // near-green corner blend
  },
  {
    name: "GP0(39h) undocumented mirror of 38h",
    words: [
      (0x39 << 24) | rgb(0, 0xf8, 0),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(110, 10),
      rgb(0xf8, 0, 0), vert(110, 110),
      rgb(0xf8, 0, 0), vert(10, 110),
    ],
    px: { x: 15, y: 15 }, want: pack5(1, 29, 0), // near-green corner blend
  },
  {
    name: "GP0(3Ah) shaded quad semi-transparent",
    words: [
      (0x3a << 24) | rgb(0, 0xf8, 0),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(110, 10),
      rgb(0xf8, 0, 0), vert(110, 110),
      rgb(0xf8, 0, 0), vert(10, 110),
    ],
    px: { x: 15, y: 15 }, want: pack5(0, 14, 0),
  },
  {
    name: "GP0(3Bh) undocumented mirror of 3Ah",
    words: [
      (0x3b << 24) | rgb(0, 0xf8, 0),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(110, 10),
      rgb(0xf8, 0, 0), vert(110, 110),
      rgb(0xf8, 0, 0), vert(10, 110),
    ],
    px: { x: 15, y: 15 }, want: pack5(0, 14, 0),
  },
  // shaded + textured: C,V,UV per vertex (9/12 words)
  {
    name: "GP0(34h) shaded tex tri blended (white shading)",
    words: [
      (0x34 << 24) | WHITE_CMD,
      vert(10, 10), UV0, WHITE_CMD,
      vert(60, 10), UV_TEXPAGE, WHITE_CMD,
      vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: pack5(31, 0, 0),
  },
  {
    name: "GP0(35h) nonsense raw shaded tri (=25h layout)",
    words: [
      (0x35 << 24) | rgb(0, 0, 0), // unused shading must not black texels
      vert(10, 10), UV0, rgb(0, 0, 0),
      vert(60, 10), UV_TEXPAGE, rgb(0, 0, 0),
      vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: pack5(2, 0, 0),
  },
  {
    name: "GP0(36h) shaded tex tri semi-transparent",
    words: [
      (0x36 << 24) | WHITE_CMD,
      vert(10, 10), UV0, WHITE_CMD,
      vert(60, 10), UV_TEXPAGE, WHITE_CMD,
      vert(10, 60), UV3,
    ],
    // Texel CLUT[0]=16 has no STP bit → drawn opaque despite bit 25.
    px: { x: 20, y: 20 }, want: pack5(31, 0, 0),
  },
  {
    name: "GP0(37h) nonsense raw shaded tri semi (=27h layout)",
    words: [
      (0x37 << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, rgb(0, 0, 0),
      vert(60, 10), UV_TEXPAGE, rgb(0, 0, 0),
      vert(10, 60), UV3,
    ],
    px: { x: 20, y: 20 }, want: pack5(2, 0, 0), // raw texel, no STP → opaque
  },
  {
    name: "GP0(3Ch) shaded tex quad blended",
    words: [
      (0x3c << 24) | WHITE_CMD,
      vert(10, 10), UV0, WHITE_CMD,
      vert(110, 10), UV_TEXPAGE, WHITE_CMD,
      vert(110, 110), UV3, WHITE_CMD,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(31, 0, 0),
  },
  {
    name: "GP0(3Dh) nonsense raw shaded quad (=2Dh, Castlevania)",
    words: [
      (0x3d << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, rgb(0, 0, 0),
      vert(110, 10), UV_TEXPAGE, rgb(0, 0, 0),
      vert(110, 110), UV3, rgb(0, 0, 0),
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(2, 0, 0),
  },
  {
    name: "GP0(3Eh) shaded tex quad semi-transparent",
    words: [
      (0x3e << 24) | WHITE_CMD,
      vert(10, 10), UV0, WHITE_CMD,
      vert(110, 10), UV_TEXPAGE, WHITE_CMD,
      vert(110, 110), UV3, WHITE_CMD,
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(31, 0, 0), // texel has no STP → opaque
  },
  {
    name: "GP0(3Fh) nonsense raw shaded quad semi (=2Fh)",
    words: [
      (0x3f << 24) | rgb(0, 0, 0),
      vert(10, 10), UV0, rgb(0, 0, 0),
      vert(110, 10), UV_TEXPAGE, rgb(0, 0, 0),
      vert(110, 110), UV3, rgb(0, 0, 0),
      vert(10, 110), UV3,
    ],
    px: { x: 60, y: 80 }, want: pack5(2, 0, 0), // raw texel, no STP → opaque
  },
];

/** no$psx packet lengths for every polygon opcode. */
const POLY_WORD_COUNT: Record<number, number> = {
  0x20: 4, 0x22: 4, 0x28: 5, 0x2a: 5,
  0x24: 7, 0x25: 7, 0x26: 7, 0x27: 7,
  0x2c: 9, 0x2d: 9, 0x2e: 9, 0x2f: 9,
  0x30: 6, 0x32: 6, 0x38: 8, 0x3a: 8,
  0x34: 9, 0x36: 9, 0x3c: 12, 0x3e: 12,
  0x35: 9, 0x37: 9, 0x3d: 12, 0x3f: 12,
  // undocumented mono/shaded mirrors share their twins' sizes
  0x21: 4, 0x23: 4, 0x29: 5, 0x2b: 5,
  0x31: 6, 0x33: 6, 0x39: 8, 0x3b: 8,
};

function polyOp(row: PolyRow): number {
  return (row.words[0]! >>> 24) & 0xff;
}

describe("GP0 polygons 20h..3Fh — decode + rasterize per opcode", () => {
  for (const row of polyRows) {
    const op = polyOp(row);
    test(`${row.name}: ${POLY_WORD_COUNT[op]}-word packet`, () => {
      const g = new Gpu();
      installRedTexel(g);
      expect(row.words.length).toBe(POLY_WORD_COUNT[op]); // hand-encode sanity
      send(g, row.words);
      expect(getPx(g, row.px.x, row.px.y)).toBe(row.want >>> 0);
    });

    test(`${row.name}: decoder idle after ${POLY_WORD_COUNT[op]} words`, () => {
      const g = new Gpu();
      installRedTexel(g);
      send(g, row.words);
      // A FillVRAM opcode word must START a new command, not be swallowed
      // as an extra polygon parameter.
      send(g, [(0x02 << 24) | rgb(0, 31 << 3, 0), (200 << 16) | 900, (2 << 16) | 8]);
      expect(getPx(g, 900, 200)).toBe(GREEN);
    });
  }
});

describe("GP0 polygon attribute decode (texpage / clut / texel fields)", () => {
  test("CLUT attribute: base = attr*16 halfwords", () => {
    const g = new Gpu();
    g.vram.fill(0);
    // 4bpp halfword 0x0001 = texels [1,0,0,0] → u=0 fetches index 1.
    g.vram[0] = 0x0001;
    setPx(g, 33, 0, GREEN); // CLUT base 32 (attr 2): entry 1 → vram[33]
    send(g, [
      (0x24 << 24) | WHITE_CMD,
      vert(10, 10), uv(0, 0, 2), // CLUT attr 2
      vert(60, 10), UV_TEXPAGE,
      vert(10, 60), UV3,
    ]);
    expect(getPx(g, 20, 20)).toBe(GREEN);
  });

  test("texpage attribute bits 0-3/4/7-8: page X base, Y base, color mode", () => {
    const g = new Gpu();
    // 15bpp direct texel at VRAM(64,256) = page X base 1, Y base 256, mode 2.
    g.vram.fill(0);
    setPx(g, 64, 256, WHITE);
    send(g, [
      (0x24 << 24) | WHITE_CMD,
      vert(10, 10), uv(0, 0, 0),
      vert(60, 10), uv(0, 0, (1 << 0) | (1 << 4) | (2 << 7)), // texpage attr
      vert(10, 60), UV3,
    ]);
    expect(getPx(g, 20, 20)).toBe(WHITE);
    // Texpage attribute bits 0-8 mirror into GPUSTAT 0-8 (no$psx).
    expect(g.readGPUSTAT() & 0x1ff).toBe((1 << 0) | (1 << 4) | (2 << 7));
  });

  test("semi-transparency rate (ABR) comes from texpage attribute bits 5-6", () => {
    const g = new Gpu();
    g.vram.fill(0);
    // 15bpp direct texel page (mode 2) at page 0: distinct color per probe.
    setPx(g, 0, 0, pack5(0, 20, 0) | 0x8000);
    send(g, [
      (0x26 << 24) | rgb(128, 128, 128), // 80h = unity modulation
      vert(5, 5), uv(0, 0, 0),
      vert(60, 10), uv(0, 0, (2 << 7) | (1 << 5)), // texpage: 15bpp, ABR=1
      vert(5, 60), uv(0, 0),
    ]);
    // Decode assertions: the texel fetch hits page 0 (vram[0], u=v=0 for all
    // vertices) and the ABR field reaches GPUSTAT 5-6. (Pixel-level blend
    // behavior of STP texels is covered by gpu-raster.test.ts.)
    expect(getPx(g, 20, 20) & 0x7fff).toBe(pack5(0, 20, 0));
    expect((g.readGPUSTAT() >>> 5) & 3).toBe(1);
    expect((g.readGPUSTAT() >>> 7) & 3).toBe(2);
  });

  test("dither flag (texpage bit 9) rides GP0(E1h) and GPUSTAT bit 9", () => {
    const g = new Gpu();
    send(g, [(0xe1 << 24) | (1 << 9)]);
    expect((g.readGPUSTAT() >>> 9) & 1).toBe(1);
  });

  test("quad consumption: full 5-word mono quad before rasterize", () => {
    const g = new Gpu();
    send(g, [(0x28 << 24) | RED_CMD, ...QUAD]);
    // All corners of the second tri (v1,v2,v3) painted → the 4th vertex
    // word was consumed, not left dangling.
    expect(getPx(g, 109, 109)).toBe(RED);
    expect(getPx(g, 11, 109)).toBe(RED);
    expect(getPx(g, 109, 11)).toBe(RED);
    expect(getPx(g, 15, 15)).toBe(RED);
  });
});

// ---------------------------------------------------------------------------
// LINES 40h..5Fh
//   40h/42h: C, V1, V2                                   3 words
//   48h/4Ah: C, V1..Vn, 55555555h                        variable
//   50h/52h: C1, V1, C2, V2                              4 words
//   58h/5Ah: C1, V1, C2, V2, ..., CN, VN, 55555555h      variable
//   (Lines INCLUDE their lower-right endpoint, unlike polygons.)
// ---------------------------------------------------------------------------
describe("GP0 lines 40h..5Fh — decode + rasterize per opcode", () => {
  test("GP0(40h) mono line opaque: 3-word packet", () => {
    const g = new Gpu();
    send(g, [(0x40 << 24) | RED_CMD, vert(20, 30), vert(40, 30)]);
    expect(getPx(g, 20, 30)).toBe(RED);
    expect(getPx(g, 40, 30)).toBe(RED); // lower-right INCLUDED
    expect(getPx(g, 19, 30)).toBe(0);
    expect(getPx(g, 41, 30)).toBe(0);
  });

  test("GP0(42h) mono line semi-transparent: B/2+F/2", () => {
    const g = new Gpu();
    for (let x = 15; x <= 45; x++) setPx(g, x, 30, GREEN);
    send(g, [(0x42 << 24) | RED_CMD, vert(20, 30), vert(40, 30)]);
    expect(getPx(g, 20, 30)).toBe(pack5(15, 15, 0));
    expect(getPx(g, 40, 30)).toBe(pack5(15, 15, 0));
    expect(getPx(g, 30, 30)).toBe(pack5(15, 15, 0));
  });

  test("GP0(48h) mono poly-line: consumes until 55555555h", () => {
    const g = new Gpu();
    send(g, [
      (0x48 << 24) | RED_CMD,
      vert(10, 10), vert(30, 10), vert(30, 40),
      0x55555555,
    ]);
    expect(getPx(g, 10, 10)).toBe(RED);
    expect(getPx(g, 30, 10)).toBe(RED);
    expect(getPx(g, 30, 40)).toBe(RED);
  });

  test("GP0(4Ah) mono poly-line semi-transparent", () => {
    const g = new Gpu();
    for (let x = 0; x <= 60; x++) setPx(g, x, 10, GREEN);
    send(g, [
      (0x4a << 24) | RED_CMD,
      vert(10, 10), vert(50, 10),
      0x55555555,
    ]);
    expect(getPx(g, 10, 10)).toBe(pack5(15, 15, 0));
    expect(getPx(g, 50, 10)).toBe(pack5(15, 15, 0));
  });

  test("GP0(50h) shaded line: C1,V1,C2,V2 rhythm (4-word packet)", () => {
    const g = new Gpu();
    send(g, [
      (0x50 << 24) | rgb(0, 0, 0xf8), // C1 blue (rides command word)
      vert(10, 10),
      rgb(0, 0xf8, 0), // C2 green
      vert(50, 10),
    ]);
    expect(getPx(g, 10, 10)).toBe(BLUE);
    expect(getPx(g, 50, 10)).toBe(GREEN);
    expect((getPx(g, 30, 10) >> 10) & 31).toBe(15); // blue halfway
    expect((getPx(g, 30, 10) >> 5) & 31).toBe(15); // green halfway
    expect(getPx(g, 30, 10) & 31).toBe(0);
  });

  test("GP0(52h) shaded line semi-transparent", () => {
    const g = new Gpu();
    for (let x = 0; x <= 60; x++) setPx(g, x, 10, GREEN);
    send(g, [
      (0x52 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0, 0xf8),
      vert(50, 10),
    ]);
    expect(getPx(g, 10, 10)).toBe(pack5(0, 15, 15));
    expect(getPx(g, 50, 10)).toBe(pack5(0, 15, 15));
  });

  test("GP0(58h) shaded poly-line with terminator", () => {
    const g = new Gpu();
    send(g, [
      (0x58 << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0xf8, 0), vert(30, 10),
      rgb(0, 0, 0xf8), vert(30, 40),
      0x55555555,
    ]);
    expect(getPx(g, 10, 10)).toBe(BLUE);
    expect(getPx(g, 30, 10)).toBe(GREEN);
    expect(getPx(g, 30, 40)).toBe(BLUE);
  });

  test("GP0(5Ah) shaded poly-line semi-transparent", () => {
    const g = new Gpu();
    for (let x = 0; x <= 60; x++) setPx(g, x, 10, GREEN);
    send(g, [
      (0x5a << 24) | rgb(0, 0, 0xf8),
      vert(10, 10),
      rgb(0, 0, 0xf8), vert(50, 10),
      0x55555555,
    ]);
    expect(getPx(g, 10, 10)).toBe(pack5(0, 15, 15));
    expect(getPx(g, 50, 10)).toBe(pack5(0, 15, 15));
  });

  test("Wild Arms 2 terminator variant 50005000h ends the list", () => {
    const g = new Gpu();
    send(g, [
      (0x48 << 24) | RED_CMD,
      vert(10, 10), vert(30, 10),
      0x50005000,
    ]);
    expect(getPx(g, 10, 10)).toBe(RED);
    expect(getPx(g, 30, 10)).toBe(RED);
  });

  test("line decoder returns to idle at terminator (no stealing)", () => {
    const g = new Gpu();
    send(g, [
      (0x48 << 24) | RED_CMD,
      vert(10, 10), vert(30, 10),
      0x55555555,
      (0x02 << 24) | rgb(0, 31 << 3, 0), (300 << 16) | 20, (4 << 16) | 16,
    ]);
    expect(getPx(g, 20, 300)).toBe(GREEN);
  });
});

// ---------------------------------------------------------------------------
// RECTANGLES 60h..7Fh
//   mono:     C, V[, W+H]              2 words fixed / 3 words variable
//   textured: C, V, UV+Clut[, W+H]     3 words fixed / 4 words variable
//   Texpage comes from GP0(E1h) ONLY (never a UV word, unlike polygons).
//   Rects exclude the lower-right pixel, are never dithered.
// ---------------------------------------------------------------------------
describe("GP0 rectangles 60h..7Fh — decode + rasterize per opcode", () => {
  test("GP0(60h) variable rect: 3-word packet", () => {
    const g = new Gpu();
    send(g, [(0x60 << 24) | rgb(0, 0xf8, 0), vert(100, 50), (8 << 16) | 20]);
    expect(getPx(g, 100, 50)).toBe(GREEN);
    expect(getPx(g, 119, 57)).toBe(GREEN);
    expect(getPx(g, 120, 50)).toBe(0); // lower-right excluded
    expect(getPx(g, 100, 58)).toBe(0);
  });

  test("GP0(62h) variable rect semi-transparent", () => {
    const g = new Gpu();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 30; x++) setPx(g, x, y, GREEN);
    send(g, [(0x62 << 24) | RED_CMD, vert(5, 5), (4 << 16) | 10]);
    expect(getPx(g, 5, 5)).toBe(pack5(15, 15, 0));
    expect(getPx(g, 14, 8)).toBe(pack5(15, 15, 0));
  });

  test("GP0(64h) textured variable rect: 4-word packet with CLUT attr", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [
      (0x64 << 24) | WHITE_CMD,
      vert(100, 100), UV0,
      (8 << 16) | 16,
    ]);
    expect(getPx(g, 100, 100)).toBe(RED);
    expect(getPx(g, 115, 107)).toBe(RED);
    expect(getPx(g, 116, 100)).toBe(0);
  });

  test("GP0(65h) textured raw rect ignores the color word", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [
      (0x65 << 24) | rgb(0, 0, 0), // black
      vert(100, 100), UV0, // texel (0,0) → CLUT[0]=16
      (8 << 16) | 16,
    ]);
    // Raw texture: texel used unmodulated → 16 → r5=2 (black color word ignored).
    expect(getPx(g, 100, 100)).toBe(pack5(2, 0, 0));
    expect(getPx(g, 115, 107)).toBe(pack5(2, 0, 0));
  });

  test("GP0(66h) textured variable rect semi-transparent", () => {
    const g = new Gpu();
    installRedTexel(g);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) setPx(g, x, y, GREEN);
    send(g, [
      (0x66 << 24) | RED_CMD,
      vert(5, 5), UV0, // texel (0,0) → CLUT[0]=16, no STP → opaque pixel
      (4 << 16) | 8,
    ]);
    // Texel index 0 reads CLUT[0] (vram[16]=0x0010→c=16 no STP) except where
    // the 4bpp fetch yields texel 0 (c=0 → STP-qualifying) — the rect interior
    // mixes both; (6,6) shows the blended black-texel case.
    expect(getPx(g, 6, 6)).toBe(pack5(0, 15, 0)); // B/2+F/2 of black texel over green
  });

  test("GP0(67h) textured variable rect semi raw", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [
      (0x67 << 24) | rgb(0, 0, 0),
      vert(200, 5), UV0, // texel (0,0) → CLUT[0]=16 raw
      (4 << 16) | 8,
    ]);
    expect(getPx(g, 200, 5)).toBe(pack5(2, 0, 0));
    expect(getPx(g, 207, 8)).toBe(pack5(2, 0, 0));
  });

  test("GP0(68h) 1x1 dot: 2-word packet", () => {
    const g = new Gpu();
    send(g, [(0x68 << 24) | RED_CMD, vert(400, 300)]);
    expect(getPx(g, 400, 300)).toBe(RED);
    expect(getPx(g, 401, 300)).toBe(0);
    expect(getPx(g, 400, 301)).toBe(0);
  });

  test("GP0(6Ch) textured 1x1: 3-word packet", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [(0x6c << 24) | WHITE_CMD, vert(400, 300), UV0]);
    expect(getPx(g, 400, 300)).toBe(RED);
    expect(getPx(g, 401, 300)).toBe(0);
  });

  test("GP0(70h) 8x8 rect: 2-word packet", () => {
    const g = new Gpu();
    send(g, [(0x70 << 24) | RED_CMD, vert(200, 200)]);
    expect(getPx(g, 200, 200)).toBe(RED);
    expect(getPx(g, 207, 207)).toBe(RED);
    expect(getPx(g, 208, 200)).toBe(0);
    expect(getPx(g, 200, 208)).toBe(0);
  });

  test("GP0(74h) textured 8x8: 3-word packet", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [(0x74 << 24) | WHITE_CMD, vert(200, 200), UV0]);
    expect(getPx(g, 200, 200)).toBe(RED);
    expect(getPx(g, 207, 207)).toBe(RED);
    expect(getPx(g, 208, 207)).toBe(0);
  });

  test("GP0(78h) 16x16 rect: 2-word packet", () => {
    const g = new Gpu();
    send(g, [(0x78 << 24) | rgb(0, 0xf8, 0), vert(300, 300)]);
    expect(getPx(g, 300, 300)).toBe(GREEN);
    expect(getPx(g, 315, 315)).toBe(GREEN);
    expect(getPx(g, 316, 300)).toBe(0);
  });

  test("GP0(7Ch) textured 16x16: 3-word packet", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [(0x7c << 24) | WHITE_CMD, vert(300, 300), UV0]);
    expect(getPx(g, 300, 300)).toBe(RED);
    expect(getPx(g, 315, 315)).toBe(RED);
    expect(getPx(g, 316, 315)).toBe(0);
  });

  test("rects take texpage from GP0(E1h), never from a UV word", () => {
    const g = new Gpu();
    installRedTexel(g);
    send(g, [(0xe1 << 24) | (2 << 7)]); // 15bpp direct mode for contrast
    send(g, [
      (0x64 << 24) | WHITE_CMD,
      vert(100, 100), UV0, // CLUT attr here is ignored in 15bpp mode
      (8 << 16) | 16,
    ]);
    // Direct 15bpp texel word vram[0]=0x0010 IS the color; 64h texture-
    // blending modulates it with the white color word (248): 16→31.
    expect(getPx(g, 100, 100)).toBe(pack5(31, 0, 0));
    expect(g.readGPUSTAT() & 0x1ff).toBe(2 << 7);
  });

  test("rect ABR (GP0(E1h) bits 5-6) drives the blend equation", () => {
    const g = new Gpu();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) setPx(g, x, y, GREEN);
    send(g, [(0xe1 << 24) | (2 << 5)]); // ABR=2 → B−F
    send(g, [(0x62 << 24) | RED_CMD, vert(5, 5), (4 << 16) | 10]);
    // B−F: R 0−31 clamps to 0, G 31−0 stays 31 → unchanged green.
    expect(getPx(g, 5, 5)).toBe(pack5(0, 31, 0));
  });

  test("rects are never dithered even with GP0(E1h) bit 9 set", () => {
    const g = new Gpu();
    send(g, [(0xe1 << 24) | (1 << 9)]); // dither ON
    // 8-bit 40 at pixel (0,0): dither table would give 36→4, plain → 5.
    send(g, [(0x60 << 24) | rgb(40, 0, 0), vert(0, 0), (2 << 16) | 2]);
    expect(getPx(g, 0, 0) & 31).toBe(5); // plain >>3, no table
  });
});

// ---------------------------------------------------------------------------
// DIRECT VRAM ACCESS — 01h, 02h, 80h, A0h, C0h with no$psx masking rules
// ---------------------------------------------------------------------------
describe("GP0 direct VRAM access (01h/02h/80h/A0h/C0h)", () => {
  test("GP0(01h) Clear Cache: single word, no parameters", () => {
    const g = new Gpu();
    send(g, [0x01000000]);
    // The very next word starts a new command (0x68 dot draws).
    send(g, [(0x68 << 24) | RED_CMD, vert(500, 100)]);
    expect(getPx(g, 500, 100)).toBe(RED);
  });

  test("GP0(02h) FillVRAM: 3-word packet, exact rectangle", () => {
    const g = new Gpu();
    send(g, [
      (0x02 << 24) | rgb(31 << 3, 0, 0), // 24bit R=248 → 15bit R=31
      (10 << 16) | 32, // X=32, Y=10 (X must be 16-aligned to survive masking)
      (8 << 16) | 16, // H=8, W=16
    ]);
    expect(getPx(g, 32, 10)).toBe(RED);
    expect(getPx(g, 47, 17)).toBe(RED);
    expect(getPx(g, 48, 10)).toBe(0);
    expect(getPx(g, 32, 18)).toBe(0);
  });

  test("GP0(02h) masking: X AND 3F0h, Y AND 1FFh, Xsiz rounds up to 16", () => {
    const g = new Gpu();
    send(g, [
      (0x02 << 24) | rgb(0, 0, 31 << 3),
      (5 << 16) | 0x123, // X=0x123 AND 3F0h = 0x120 = 288; Y=5
      (5 << 16) | 10, // Xsiz=10 rounds up to 16; Ysiz=5
    ]);
    expect(getPx(g, 288, 5)).toBe(BLUE);
    expect(getPx(g, 303, 9)).toBe(BLUE); // 16 wide
    expect(getPx(g, 304, 5)).toBe(0);
    expect(getPx(g, 288, 10)).toBe(0);
  });

  test("GP0(02h) fill writes bit15=0 (24bit→15bit conversion)", () => {
    const g = new Gpu();
    send(g, [(0x02 << 24) | 0x00f8f8f8, 0, (4 << 16) | 16]);
    expect(getPx(g, 0, 0) & 0x8000).toBe(0);
  });

  test("GP0(02h) Xsiz=0 or Ysiz=0 means NO fill (copy commands differ!)", () => {
    const g = new Gpu();
    send(g, [(0x02 << 24) | rgb(31 << 3, 0, 0), 0, 0]);
    expect(getPx(g, 0, 0)).toBe(0);
  });

  test("GP0(80h) VRAM→VRAM copy: 4-word packet (cmd + 3 params)", () => {
    const g = new Gpu();
    setPx(g, 40, 30, RED);
    setPx(g, 41, 30, GREEN);
    setPx(g, 40, 31, BLUE);
    send(g, [
      0x80000000,
      (30 << 16) | 40, // source (40,30)
      (100 << 16) | 200, // dest (200,100)
      (2 << 16) | 2, // 2x2
    ]);
    expect(getPx(g, 200, 100)).toBe(RED);
    expect(getPx(g, 201, 100)).toBe(GREEN);
    expect(getPx(g, 200, 101)).toBe(BLUE);
    expect(getPx(g, 40, 30)).toBe(RED); // source untouched
  });

  test("GP0(80h) size 0 handled as max (copy rule)", () => {
    const g = new Gpu();
    for (let x = 0; x < 8; x++) setPx(g, x, 0, RED);
    send(g, [
      0x80000000,
      0, // source (0,0)
      (0 << 16) | 500, // dest (500,0)
      0, // (0-1)&3FF+1 = 1024 wide, (0-1)&1FF+1 = 512 tall
    ]);
    expect(getPx(g, 500, 0)).toBe(RED);
    expect(getPx(g, 507, 0)).toBe(RED);
    expect(getPx(g, 508, 0)).toBe(0);
  });

  test("GP0(A0h) CPU→VRAM: 3 header words + ceil(W*H/2) data words", () => {
    const g = new Gpu();
    send(g, [
      0xa0000000,
      (20 << 16) | 30, // dest (30,20)
      (1 << 16) | 2, // 2x1 → 1 data word
      RED | (GREEN << 16), // low halfword first
    ]);
    expect(getPx(g, 30, 20)).toBe(RED);
    expect(getPx(g, 31, 20)).toBe(GREEN);
  });

  test("GP0(A0h) odd halfword count: packet rounds up to whole words", () => {
    const g = new Gpu();
    send(g, [
      0xa0000000,
      0, // dest (0,0)
      (1 << 16) | 3, // 3 halfwords → 2 data words (extra halfword padded)
      pack5(1, 2, 3) | (pack5(4, 5, 6) << 16),
      pack5(7, 8, 9), // padded word, upper half discarded
    ]);
    expect(getPx(g, 0, 0)).toBe(pack5(1, 2, 3));
    expect(getPx(g, 1, 0)).toBe(pack5(4, 5, 6));
    expect(getPx(g, 2, 0)).toBe(pack5(7, 8, 9));
    expect(getPx(g, 3, 0)).toBe(0); // no phantom 4th pixel
  });

  test("GP0(A0h) width wraps at VRAM edge without Y carry", () => {
    const g = new Gpu();
    send(g, [
      0xa0000000,
      (0 << 16) | 1022, // dest near the right edge
      (2 << 16) | 4, // 4 wide → wraps to X 0,1 of the SAME row
      pack5(1, 0, 0) | (pack5(2, 0, 0) << 16),
      pack5(3, 0, 0) | (pack5(4, 0, 0) << 16),
    ]);
    expect(getPx(g, 1022, 0)).toBe(pack5(1, 0, 0));
    expect(getPx(g, 1023, 0)).toBe(pack5(2, 0, 0));
    expect(getPx(g, 0, 0)).toBe(pack5(3, 0, 0));
    expect(getPx(g, 1, 0)).toBe(pack5(4, 0, 0));
    expect(getPx(g, 2, 0)).toBe(0); // no carry into the next row
  });

  test("GP0(C0h) VRAM→CPU: 3-word header, decoder idle after header", () => {
    const g = new Gpu();
    setPx(g, 60, 70, pack5(10, 20, 30));
    send(g, [
      0xc0000000,
      (70 << 16) | 60, // source (60,70)
      (1 << 16) | 1, // 1x1
    ]);
    // Reads flow out via GPUREAD; the decoder must be idle so the next
    // word is a fresh opcode.
    send(g, [(0x68 << 24) | rgb(0, 0xf8, 0), vert(90, 70)]);
    expect(getPx(g, 60, 70)).toBe(pack5(10, 20, 30));
    expect(getPx(g, 90, 70)).toBe(GREEN);
  });
});

// ---------------------------------------------------------------------------
// OPCODE DISPATCH — non-render opcodes must not swallow parameters
// ---------------------------------------------------------------------------
describe("GP0 dispatch sanity", () => {
  test("GP0(00h) NOP does not consume following words", () => {
    const g = new Gpu();
    send(g, [0x00000000, (0x68 << 24) | RED_CMD, vert(600, 400)]);
    expect(getPx(g, 600, 400)).toBe(RED);
  });

  test("GP0(03h) undocumented does not enter parameter mode", () => {
    const g = new Gpu();
    send(g, [0x03000000, (0x68 << 24) | rgb(0, 0xf8, 0), vert(601, 401)]);
    expect(getPx(g, 601, 401)).toBe(GREEN);
  });

  test("E1h..E6h attribute commands take no FIFO parameters", () => {
    const g = new Gpu();
    send(g, [
      (0xe1 << 24) | (2 << 7), // texpage mode 2
      (0xe2 << 24) | (0x1f | (0x0f << 10)), // texwindow
      (0xe3 << 24) | (100 | (50 << 10)), // draw area top-left
      (0xe4 << 24) | (200 | (100 << 10)), // draw area bottom-right
      (0xe5 << 24) | (10 | (20 << 11)), // draw offset
      // immediately a render command (offset moves the dot into the clip):
      (0x68 << 24) | RED_CMD, vert(150, 70),
    ]);
    expect(getPx(g, 160, 90)).toBe(RED); // (150,70)+offset(10,20), inside area
    expect(g.readGPUSTAT() & 0x1ff).toBe(2 << 7);
  });
});
