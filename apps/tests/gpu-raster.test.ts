/**
 * gpu-raster.test.ts — formal-first verification for the Phase 2 software
 * rasterizer (no$psx GPU rendering semantics):
 * 1. Golden vector: hand-computed exact pixel coverage of a right triangle
 *    (closed spans, bottom edge included) → mask compare against the exact
 *    expected set plus a whole-VRAM untouched check.
 * 2. Drawing-area clip: snapshot compare of all VRAM outside the clip rect
 *    after randomized prims; degenerate clip writes nothing.
 * 3. Gouraud gradient: exact interpolated colors on a strip (hand-computed).
 * 4. Textured 4bpp/8bpp/15bpp: CLUT patterns → exact pixel colors.
 * 5. Blend modes 0-3: single-pixel B+F cases with known values.
 * 6. CLUT STP bit forces semi-transparency even when prim.semiTrans=false.
 * Randomized OOB property: mulberry32 seeded PRNG (reproducible).
 * All expected values hand-derived; no rasterizer code reused in tests.
 */
import { describe, expect, test } from "bun:test";
import { type Prim, type PrimVert, rasterize } from "../src/core/gpu-raster.ts";

const VRAM_W = 1024;
const VRAM_H = 512;

function makeGpu(): { vram: Uint16Array } {
  return { vram: new Uint16Array(VRAM_W * VRAM_H) };
}

function flatPrim(over: Partial<Prim> = {}): Prim {
  return {
    kind: "tri",
    vertices: [],
    colorMode: "flat",
    textured: false,
    blendMode: 0,
    texPage: 0,
    clutBase: 0,
    dither: false,
    semiTrans: false,
    ...over,
  };
}

/** Pack 5-bit channels into the VRAM 15bpp word: R bits 0-4, G 5-9, B 10-14. */
function pack(r: number, g: number, b: number): number {
  return (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
}

function v(x: number, y: number, r = 248, g = 0, b = 0, u = 0, vv = 0): PrimVert {
  return { x, y, r, g, b, u, v: vv };
}

function setPx(g: { vram: Uint16Array }, x: number, y: number, c: number): void {
  g.vram[y * VRAM_W + x] = c;
}

function getPx(g: { vram: Uint16Array }, x: number, y: number): number {
  return g.vram[y * VRAM_W + x]!;
}

/** mulberry32 — small seeded PRNG for reproducible randomized tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Golden vector: right triangle (10,10)-(60,10)-(10,60), flat red.
// Hand-computed closed-span coverage: for each y in 10..60, x runs 10..60-(y-10):
// both boundary pixels drawn, hypotenuse endpoint (60-(y-10), y) included,
// bottom row y=60 is the single pixel (10,60).
describe("golden vector coverage", () => {
  test("right triangle (10,10)-(60,10)-(10,60) exact pixel set", () => {
    const gpu = makeGpu();
    rasterize(gpu, flatPrim({ vertices: [v(10, 10), v(60, 10), v(10, 60)] }));
    const RED = 31; // r5=31 → bits 0-4
    const covered = new Set<number>();
    for (let y = 10; y <= 60; y++) {
      for (let x = 10; x <= 60 - (y - 10); x++) {
        covered.add(y * VRAM_W + x);
        expect(getPx(gpu, x, y)).toBe(RED);
      }
    }
    // No pixel outside the wedge was touched.
    for (let i = 0; i < gpu.vram.length; i++) {
      if (!covered.has(i)) expect(gpu.vram[i]).toBe(0);
    }
    expect(covered.size).toBe(1326); // sum_{k=0..50}(51-k) = 51·52/2
  });

  test("flat color comes from vertex 0 even when others differ", () => {
    const gpu = makeGpu();
    rasterize(
      gpu,
      flatPrim({
        vertices: [v(100, 100, 0, 248, 0), v(102, 100), v(100, 102)],
      }),
    );
    expect(getPx(gpu, 101, 101)).toBe(pack(0, 31, 0)); // green
    expect(getPx(gpu, 100, 100)).toBe(pack(0, 31, 0));
  });

  test("quad = two triangles across the v1-v2 diagonal", () => {
    const gpu = makeGpu();
    rasterize(
      gpu,
      flatPrim({
        kind: "quad",
        vertices: [v(200, 200), v(203, 200), v(203, 203), v(200, 203)],
      }),
    );
    // Interior 3×3 spans come from triangle (v0,v1,v2); the bottom row and
    // right column come from (v1,v2,v3) sharing the v1-v2 diagonal.
    for (let y = 200; y <= 202; y++)
      for (let x = 201; x <= 203; x++) expect(getPx(gpu, x, y)).toBe(31);
    expect(getPx(gpu, 200, 203)).toBe(31);
    expect(getPx(gpu, 201, 203)).toBe(31);
    expect(getPx(gpu, 202, 203)).toBe(31);
    expect(getPx(gpu, 203, 203)).toBe(31);
    // Untouched border.
    expect(getPx(gpu, 199, 200)).toBe(0);
    expect(getPx(gpu, 204, 203)).toBe(0);
    expect(getPx(gpu, 200, 199)).toBe(0);
    expect(getPx(gpu, 200, 204)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. OOB + drawing-area clip property (seeded randomized).
describe("clip and bounds property", () => {
  test("randomized prims never write outside VRAM or the drawing area", () => {
    const rnd = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 300; iter++) {
      const gpu = makeGpu();
      const cx1 = 100 + Math.floor(rnd() * 300);
      const cy1 = 50 + Math.floor(rnd() * 100);
      const cx2 = cx1 + 1 + Math.floor(rnd() * 400);
      const cy2 = cy1 + 1 + Math.floor(rnd() * 200);
      const gpuWithClip = { vram: gpu.vram, clipX1: cx1, clipY1: cy1, clipX2: cx2, clipY2: cy2 };
      // Every pixel outside the clip rect must stay zero (VRAM starts zeroed).
      const verts: PrimVert[] = [];
      const n = 3 + (iter % 2);
      for (let i = 0; i < n; i++)
        verts.push(
          v(
            Math.floor(rnd() * 2048) - 1024, // full 11-bit signed range
            Math.floor(rnd() * 512) - 256, // full 9-bit signed range
            Math.floor(rnd() * 256),
            Math.floor(rnd() * 256),
            Math.floor(rnd() * 256),
          ),
        );
      rasterize(
        gpuWithClip,
        flatPrim({
          kind: n === 4 ? "quad" : "tri",
          vertices: verts,
          semiTrans: rnd() < 0.5,
          blendMode: Math.floor(rnd() * 4) as 0 | 1 | 2 | 3,
          dither: rnd() < 0.5,
        }),
      );
      // Fast zero-scan outside the clip rect; expect() only on violation.
      for (let y = 0; y < VRAM_H; y++) {
        const row = y * VRAM_W;
        const xEnd = y < cy1 || y > cy2 ? VRAM_W - 1 : Math.min(cx2 + 1, VRAM_W - 1);
        const xStart = y < cy1 || y > cy2 ? 0 : cx1;
        for (let x = 0; x < xStart; x++)
          if (gpu.vram[row + x] !== 0) expect(gpu.vram[row + x]).toBe(0);
        for (let x = xEnd + 1; x < VRAM_W; x++)
          if (gpu.vram[row + x] !== 0) expect(gpu.vram[row + x]).toBe(0);
      }
    }
  }, 5000);

  test("degenerate clip rect writes nothing", () => {
    const gpu = makeGpu();
    const g = { vram: gpu.vram, clipX1: 500, clipY1: 400, clipX2: 499, clipY2: 499 };
    rasterize(g, flatPrim({ vertices: [v(0, 0), v(1023, 0), v(0, 511)] }));
    expect(g.vram.every((p) => p === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Gouraud interpolation.
describe("gouraud interpolation", () => {
  test("2-wide vertical strip ramps 0→31 down its 32 scanlines", () => {
    const gpu = makeGpu();
    rasterize(
      gpu,
      flatPrim({
        colorMode: "gouraud",
        kind: "quad",
        vertices: [
          v(300, 100, 0, 0, 0),
          v(301, 100, 0, 0, 0),
          v(301, 131, 248, 0, 0),
          v(300, 131, 248, 0, 0),
        ],
      }),
    );
    for (let y = 100; y <= 131; y++) {
      // Hand-computed: the left column (x=300) sits exactly on the A→C left
      // edge → t=0 → r stays 0 (31 at the bottom vertex row). The right
      // column (x=301) interpolates along the top edge A→B: gradient 0→31
      // across 32 scanlines → expected r5 = y - 100.
      expect(getPx(gpu, 300, y)).toBe(y === 131 ? 31 : 0);
      expect(getPx(gpu, 301, y)).toBe(y - 100);
    }
    expect(getPx(gpu, 302, 110)).toBe(0);
  });

  test("diagonal gouraud triangle: corners exact, interior in range", () => {
    const gpu = makeGpu();
    rasterize(
      gpu,
      flatPrim({
        colorMode: "gouraud",
        vertices: [v(0, 0, 255, 0, 0), v(31, 0, 0, 255, 0), v(0, 31, 0, 0, 255)],
      }),
    );
    expect(getPx(gpu, 0, 0) & 31).toBe(31); // pure red corner (255>>3)
    expect((getPx(gpu, 31, 0) >> 5) & 31).toBe(31); // pure green corner
    expect((getPx(gpu, 0, 31) >> 10) & 31).toBe(31); // pure blue corner
    // Along the top edge r decays while g grows (linear both ways).
    const mid = getPx(gpu, 16, 0);
    expect(mid & 31).toBeLessThanOrEqual(16);
    expect((mid >> 5) & 31).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// 4. Textured prims: 4bpp CLUT / 8bpp CLUT / 15bpp direct.
describe("textured primitives", () => {
  test("4bpp: 8×8 pattern via CLUT, texPage (0,0), unity modulation", () => {
    const gpu = makeGpu();
    // Pattern at texpage (0,0): texel row v reads vram[v*1024 + u>>2].
    // Texel value = row index → CLUT entry → color row*100.
    for (let row = 0; row < 8; row++) {
      for (let hw = 0; hw < 2; hw++) {
        let word = 0;
        for (let t = 0; t < 4; t++) word |= row << (t * 4);
        gpu.vram[row * VRAM_W + hw] = word;
      }
    }
    // CLUT at the start of VRAM row 100 — disjoint from texture rows 0-7.
    const clutBase = 100 * VRAM_W;
    for (let e = 0; e < 16; e++) gpu.vram[clutBase + e] = e * 100;
    rasterize(
      gpu,
      flatPrim({
        textured: true,
        texPage: 0,
        clutBase,
        kind: "quad",
        vertices: [
          v(500, 100, 128, 128, 128, 0, 0),
          v(507, 100, 128, 128, 128, 7, 0),
          v(507, 107, 128, 128, 128, 7, 7),
          v(500, 107, 128, 128, 128, 0, 7),
        ],
      }),
    );
    // u/v are exact screen offsets here: texel (u,v) = (x-500, y-100).
    // Prim color 128 = unity modulation gain; row*100 < 1024, so the packed
    // BGR555 word round-trips: pixel === row*100.
    for (let y = 101; y <= 107; y++)
      for (let x = 501; x <= 507; x++) {
        const got = getPx(gpu, x, y);
        if (got !== 0) expect(got).toBe((y - 100) * 100);
      }
    // Specific hand-picked texels: (503,104) → texel (3,4) → CLUT[4] = 400.
    expect(getPx(gpu, 503, 104)).toBe(400);
    expect(getPx(gpu, 502, 105)).toBe(500);
    expect(getPx(gpu, 507, 107)).toBe(700);
    // Outside the quad: untouched.
    expect(getPx(gpu, 499, 100)).toBe(0);
    expect(getPx(gpu, 508, 107)).toBe(0);
    expect(getPx(gpu, 500, 108)).toBe(0);
  });

  test("8bpp: CLUT sampled through texPage mode bits (texPage bit 7)", () => {
    const gpu = makeGpu();
    // 8bpp: texel u reads halfword vram[200*1024 + u>>1] (texpage (0,0), v=200).
    // Cols 2k and 2k+1 both map to CLUT index 2k. Both texel rows (200, 201)
    // carry the same pattern — the quad spans v=200..201.
    for (const row of [200, 201])
      for (let k = 0; k < 4; k++)
        gpu.vram[row * VRAM_W + k] = ((2 * k + 1) << 8) | 2 * k;
    const clutBase = 300 * VRAM_W; // row 300: disjoint from texture row 200
    for (let e = 0; e < 16; e++) gpu.vram[clutBase + e] = 300 + e;
    rasterize(
      gpu,
      flatPrim({
        textured: true,
        texPage: 1 << 7, // mode 1 = 8bpp
        clutBase,
        kind: "quad",
        vertices: [
          v(600, 200, 128, 128, 128, 0, 200),
          v(607, 200, 128, 128, 128, 7, 200),
          v(607, 201, 128, 128, 128, 7, 201),
          v(600, 201, 128, 128, 128, 0, 201),
        ],
      }),
    );
    // Unity modulation; 300+i < 512 → packed word round-trips.
    // Texel u=600+i has value i (low byte for even i, high for odd — wait:
    // halfword k packs texels 2k (low) and 2k+1 (high), so u=600+i → value i.
    for (let i = 0; i < 8; i++) {
      expect(getPx(gpu, 600 + i, 200)).toBe(300 + i);
      expect(getPx(gpu, 600 + i, 201)).toBe(300 + i);
    }
    expect(getPx(gpu, 599, 200)).toBe(0);
    expect(getPx(gpu, 608, 201)).toBe(0);
  });

  test("15bpp direct mode (texPage bits 7-8 = 2) bypasses CLUT", () => {
    const gpu = makeGpu();
    // texPage X base 1 → fetch addr = 64 + u (u page-relative 0..63).
    gpu.vram[64] = 0x7fff; // pageX base texel: white
    gpu.vram[65] = 20; // dim red (R=20, G=0, B=0)
    gpu.vram[64 + VRAM_W] = 0x7fff; // texel row 1: white
    rasterize(
      gpu,
      flatPrim({
        textured: true,
        texPage: 1 | (2 << 7), // pageX=1 (texel 64), mode 2 = 15bpp
        vertices: [
          v(700, 300, 128, 128, 128, 0, 0),
          v(702, 300, 128, 128, 128, 2, 0),
          v(700, 301, 128, 128, 128, 0, 1),
        ],
      }),
    );
    // White texel: t8 = (31<<3)|(31>>2) = 255, mod(255,128) = 255 → 31/channel.
    expect(getPx(gpu, 700, 300)).toBe(pack(31, 31, 31));
    // Dim red 20: t8 = 165, mod → 165, to5 → 20; G/B texel fields 0.
    expect(getPx(gpu, 701, 300)).toBe(pack(20, 0, 0));
    expect(getPx(gpu, 700, 301)).toBe(pack(31, 31, 31));
    expect(getPx(gpu, 699, 300)).toBe(0);
    expect(getPx(gpu, 702, 301)).toBe(0);
  });

  test("texel wrap modula VRAM size at edges (no OOB)", () => {
    const gpu = makeGpu();
    gpu.vram[(511 * VRAM_W) + 1023] = 31;
    expect(() =>
      rasterize(
        gpu,
        flatPrim({
          textured: true,
          texPage: 2 << 7, // 15bpp at page (0,0)
          vertices: [
            v(0, 0, 128, 128, 128, 1023, 511),
            v(1, 0, 128, 128, 128, 0, 511),
            v(0, 1, 128, 128, 128, 1023, 0),
          ],
        }),
      ),
    ).not.toThrow();
    expect(getPx(gpu, 0, 0)).toBe(31); // texel 31 → unity-modulated r5=31
  });
});

// ---------------------------------------------------------------------------
// 5. Blend modes on a single pixel.
describe("blend modes", () => {
  function blendCase(mode: 0 | 1 | 2 | 3, back: number, front: number, semi = true): number {
    const gpu = makeGpu();
    setPx(gpu, 400, 300, pack(back, 0, 0));
    rasterize(
      gpu,
      flatPrim({
        semiTrans: semi,
        blendMode: mode,
        vertices: [v(400, 300, front << 3, 0, 0), v(401, 300), v(400, 301)],
      }),
    );
    return getPx(gpu, 400, 300) & 31;
  }

  test("mode 0: 1.0B + 0.5F", () => {
    expect(blendCase(0, 20, 10)).toBe(25); // 20 + (10>>1)
  });
  test("mode 1: 1.0B + 1.0F", () => {
    expect(blendCase(1, 20, 10)).toBe(30);
  });
  test("mode 2: 1.0B - 1.0F clamps at 0", () => {
    expect(blendCase(2, 20, 10)).toBe(10);
    expect(blendCase(2, 5, 10)).toBe(0);
  });
  test("mode 3: 1.0B + 0.25F clamps at 31", () => {
    expect(blendCase(3, 20, 12)).toBe(23); // 20 + (12>>2)
    expect(blendCase(3, 28, 31)).toBe(31); // 28 + 7 → clamp
  });
  test("blend applies only when semiTrans (or texel STP)", () => {
    expect(blendCase(1, 20, 10, false)).toBe(10); // opaque overwrite
  });

  test("CLUT STP bit forces blending without prim.semiTrans", () => {
    const gpu = makeGpu();
    setPx(gpu, 400, 300, pack(20, 0, 0));
    gpu.vram[4096] = 10 | 0x8000; // CLUT[0]: red 10 + STP
    // 15bpp texpage would ignore CLUT, so use 4bpp and point texel 0 at it.
    // 4bpp texel (u=400,v=300) reads halfword at (300*1024 + (400>>2)) = 308000.
    gpu.vram[300 * VRAM_W + (400 >> 2)] = 0; // texel index 0 → CLUT[0]
    rasterize(
      gpu,
      flatPrim({
        textured: true,
        semiTrans: false,
        blendMode: 1,
        clutBase: 4096,
        vertices: [
          v(400, 300, 128, 128, 128, 400, 300),
          v(401, 300, 128, 128, 128, 401, 300),
          v(400, 301, 128, 128, 128, 400, 301),
        ],
      }),
    );
    expect(getPx(gpu, 400, 300) & 31).toBe(30); // 20+10 blended despite semiTrans=false
  });

  test("dither adds the 4×4 table before 5-bit truncation", () => {
    const gpu = makeGpu();
    // 8-bit color 40 = 5*8: without dither → 5; with table (+4/-3/…),
    // pixel (0,0) gets 40-4=36 → 4, pixel (1,0) gets 40+0=40 → 5.
    rasterize(
      gpu,
      flatPrim({
        dither: true,
        vertices: [v(512, 256, 40, 0, 0), v(513, 256), v(512, 257)],
      }),
    );
    expect(getPx(gpu, 512, 256)).toBe(4);
    expect(getPx(gpu, 513, 256)).toBe(5);
    // Same prim without dither truncates flat.
    const gpu2 = makeGpu();
    rasterize(
      gpu2,
      flatPrim({ vertices: [v(512, 256, 40, 0, 0), v(513, 256), v(512, 257)] }),
    );
    expect(getPx(gpu2, 512, 256)).toBe(5);
  });
});
