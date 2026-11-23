/**
 * gpu-raster.ts — Phase 2 software rasterizer for PS1 GPU polygons.
 * Pure functions over the passed VRAM (Uint16Array 1024×512, 15bpp BGR555:
 * bits 0-4 R, 5-9 G, 10-14 B, bit 15 = STP). No imports, no DOM.
 *
 * Conventions / documented notes:
 * - Vertex coords: both X and Y sign-extended from 11 bits (no$psx
 *   Rendering Attributes: X bits 0-10, Y bits 16-26, each -1024..+1023);
 *   pixels outside the drawing area are discarded. Drawing area read from
 *   (gpu as any).clipX1/clipY1/clipX2/clipY2 (inclusive), default
 *   0/0/1023/511, hard-clamped to VRAM bounds.
 * - Rasterization: scanline integer DDA. ALL interpolation runs in 16.16
 *   fixed point on integers (Math.round only on exact integer ratios; the
 *   final ceil/floor for span ends operate on exact integer/2^16 values in
 *   float64 — deterministic, no accumulated error). Spans are CLOSED: both
 *   boundary pixels of a span are drawn and the last scanline
 *   (floor(maxY)) is drawn, so bottom edges/vertices are included
 *   [UNVERIFIED: exact hardware edge-inclusion rule; adjacent primitives
 *   may overdraw shared edges].
 * - Colors: vertex r/g/b are 8-bit (PS1 command-word units). Interpolation
 *   is linear 16.16 fixed point on 8-bit channels; output truncates to
 *   5 bits (>>3), optionally after adding the PS1 4×4 dither table
 *   (spec-copied from no$psx), clamped to 0..31.
 * - Textured: texPage mirrors the GPUSTAT layout: bits 0-3 page X base
 *   (×64 halfwords), bit 4 page Y base (×256), bits 7-8 color mode
 *   (0 = 4bpp CLUT, 1 = 8bpp CLUT, 2/3 = 15bpp direct). CLUT lives at the
 *   linear VRAM offset clutBase (16 entries for 4bpp, 256 for 8bpp).
 *   Texel color modulates the primitive color PS1-style: texel8 =
 *   (t<<3)|(t>>2), f8 = (texel8 * col8) >> 7 clamped to 255 (col8 = 128 is
 *   unity) [UNVERIFIED: rounding of the modulation]. Texture window NOT
 *   implemented (not required this phase); texel coords wrap modulo VRAM
 *   size [UNVERIFIED: hardware wrap window].
 * - Blending (per no$psx, per 5-bit channel, integer approximations):
 *   0: B + (F>>1)   (1.0B + 0.5F)
 *   1: B + F        (1.0B + 1.0F)
 *   2: B - F        (1.0B - 1.0F)
 *   3: B + (F>>2)   (1.0B + 0.25F)
 *   each clamped to 0..31. Applied when prim.semiTrans, or when a CLUT /
 *   15bpp texel carries its STP bit (15).
 * - Set-mask-bit handling: NOT implemented this phase (optional per plan).
 * - Quads: drawn as two triangles (v0,v1,v2) + (v1,v2,v3) sharing the
 *   v1-v2 diagonal, mirroring the PS1 hardware decomposition [UNVERIFIED:
 *   hardware diagonal choice].
 */

export interface PrimVert {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  u: number;
  v: number;
}

export interface Prim {
  kind: "tri" | "quad";
  vertices: PrimVert[];
  colorMode: "flat" | "gouraud";
  textured: boolean;
  blendMode: 0 | 1 | 2 | 3;
  texPage: number;
  clutBase: number;
  dither: boolean;
  semiTrans: boolean;
}

/** Standard PS1 dither table (no$psx GPU chapter, spec-copied). */
const DITHER: readonly number[][] = [
  [-4, 0, -3, 1],
  [2, -2, 3, -1],
  [-3, 1, -4, 0],
  [3, -1, 2, -2],
];

const ONE = 1 << 16; // 16.16 fixed point

interface Vert {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  u: number;
  v: number;
}

/** Scanline edge intersection: position + attributes, all 16.16 fixed. */
interface Pt {
  xf: number;
  rf: number;
  gf: number;
  bf: number;
  uf: number;
  vf: number;
}

interface ClipRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface DrawOffset {
  x: number;
  y: number;
}

function drawOffset(gpu: { vram: Uint16Array }): DrawOffset {
  const g = gpu as unknown as Partial<Record<string, number | undefined>>;
  return {
    x: typeof g.drawOffsetX === "number" ? g.drawOffsetX : 0,
    y: typeof g.drawOffsetY === "number" ? g.drawOffsetY : 0,
  };
}

/** round(a*b/den) on exact integers (double holds these exactly). */
function mulDiv(a: number, b: number, den: number): number {
  return den > 0 ? Math.round((a * b) / den) : 0;
}

/** Sign-extend 11-bit X / 9-bit Y, mask colors to 8-bit (no$psx coords). */
function decVert(p: PrimVert): Vert {
  return {
    x: ((p.x & 0x7ff) << 21) >> 21,
    y: ((p.y & 0x7ff) << 21) >> 21,
    r: p.r & 255,
    g: p.g & 255,
    b: p.b & 255,
    u: p.u | 0,
    v: p.v | 0,
  };
}

function endPoint(p: Vert): Pt {
  return {
    xf: p.x * ONE,
    rf: p.r * ONE,
    gf: p.g * ONE,
    bf: p.b * ONE,
    uf: p.u * ONE,
    vf: p.v * ONE,
  };
}

/**
 * Intersection of edge p→q with scanline `y` (integer coords). Horizontal
 * edges (p.y === q.y) contribute both endpoints and only at their own
 * scanline; otherwise one interpolated point. Integer DDA: attribute step
 * is (q-p)*t/dy in 16.16 fixed point.
 */
function edgePoints(p: Vert, q: Vert, y: number): Pt[] {
  if (q.y === p.y) return y === p.y ? [endPoint(p), endPoint(q)] : [];
  if (q.y < p.y) {
    const t = p;
    p = q;
    q = t;
  }
  if (y < p.y || y > q.y) return [];
  const t = y - p.y;
  const dy = q.y - p.y;
  const step = (a: number, b: number): number => a * ONE + mulDiv((b - a) * ONE, t, dy);
  return [
    {
      xf: step(p.x, q.x),
      rf: step(p.r, q.r),
      gf: step(p.g, q.g),
      bf: step(p.b, q.b),
      uf: step(p.u, q.u),
      vf: step(p.v, q.v),
    },
  ];
}

/** 8-bit channel → 5-bit output, with optional dither (no$psx pipeline). */
function to5(v8: number, x: number, y: number, dither: boolean): number {
  let v = v8;
  if (dither) v += DITHER[y & 3]![x & 3]!;
  v = v < 0 ? 0 : v > 255 ? 255 : v;
  return v >> 3;
}

interface Texel {
  c: number; // 15bpp BGR555
  stp: boolean; // bit 15 of the CLUT entry / direct texel
}

/** Texture fetch: 4bpp/8bpp via CLUT at clutBase, or 15bpp direct. */
function sampleTexel(vram: Uint16Array, prim: Prim, u: number, v: number): Texel {
  const rd = (i: number): number =>
    i >= 0 && i < vram.length ? vram[i]! : 0;
  const texX = (prim.texPage & 0xf) * 64;
  const texY = ((prim.texPage >> 4) & 1) * 256;
  const mode = (prim.texPage >> 7) & 3;
  const uu = u & 1023;
  const vv = v & 511;
  if (mode === 0) {
    // 4bpp CLUT: 4 texels per halfword
    const hw = rd((texY + vv) * 1024 + texX + (uu >> 2));
    const idx = (hw >> ((uu & 3) * 4)) & 0xf;
    const e = rd(prim.clutBase + idx);
    return { c: e & 0x7fff, stp: (e >>> 15) === 1 };
  }
  if (mode === 1) {
    // 8bpp CLUT: 2 texels per halfword
    const hw = rd((texY + vv) * 1024 + texX + (uu >> 1));
    const idx = (hw >> ((uu & 1) * 8)) & 0xff;
    const e = rd(prim.clutBase + idx);
    return { c: e & 0x7fff, stp: (e >>> 15) === 1 };
  }
  // mode 2/3: 15bpp direct
  const px = rd((texY + vv) * 1024 + texX + uu);
  return { c: px & 0x7fff, stp: (px >>> 15) === 1 };
}

/** One output pixel: shade (texture-modulate + dither + 5-bit), blend, write. */
function putPixel(
  vram: Uint16Array,
  stride: number,
  prim: Prim,
  x: number,
  y: number,
  ditherX: number,
  ditherY: number,
  r8: number,
  g8: number,
  b8: number,
  texel: Texel | null,
): void {
  let r5: number, g5: number, b5: number;
  if (texel !== null) {
    // PS1 modulation: texel8 = (t<<3)|(t>>2); f8 = texel8*col8 >> 7.
    const mod = (t5: number, c8: number): number => {
      const t8 = (t5 << 3) | (t5 >> 2);
      const f = (t8 * c8) >> 7;
      return f > 255 ? 255 : f;
    };
    r5 = to5(mod(texel.c & 31, r8), ditherX, ditherY, prim.dither);
    g5 = to5(mod((texel.c >> 5) & 31, g8), ditherX, ditherY, prim.dither);
    b5 = to5(mod((texel.c >> 10) & 31, b8), ditherX, ditherY, prim.dither);
  } else {
    r5 = to5(r8, ditherX, ditherY, prim.dither);
    g5 = to5(g8, ditherX, ditherY, prim.dither);
    b5 = to5(b8, ditherX, ditherY, prim.dither);
  }
  const idx = y * stride + x;
  const back = vram[idx]!;
  const stp = texel !== null && texel.stp;
  if (!prim.semiTrans && !stp) {
    vram[idx] = r5 | (g5 << 5) | (b5 << 10);
    return;
  }
  const br = back & 31;
  const bg = (back >> 5) & 31;
  const bb = (back >> 10) & 31;
  let or_: number, og: number, ob: number;
  switch (prim.blendMode) {
    case 0:
      or_ = br + (r5 >> 1);
      og = bg + (g5 >> 1);
      ob = bb + (b5 >> 1);
      break;
    case 1:
      or_ = br + r5;
      og = bg + g5;
      ob = bb + b5;
      break;
    case 2:
      or_ = br - r5;
      og = bg - g5;
      ob = bb - b5;
      break;
    default:
      or_ = br + (r5 >> 2);
      og = bg + (g5 >> 2);
      ob = bb + (b5 >> 2);
      break;
  }
  const cl = (v: number): number => (v < 0 ? 0 : v > 31 ? 31 : v);
  vram[idx] = cl(or_) | (cl(og) << 5) | (cl(ob) << 10);
}

function drawTri(
  vram: Uint16Array,
  textureVram: Uint16Array,
  stride: number,
  scale: 1 | 2 | 4,
  clip: ClipRect,
  offset: DrawOffset,
  prim: Prim,
  v0: PrimVert,
  v1: PrimVert,
  v2: PrimVert,
): void {
  let A = decVert(v0);
  let B = decVert(v1);
  let C = decVert(v2);
  // Texture coordinates stay in native texel space; only geometry is scaled.
  A.x = (A.x + offset.x) * scale; A.y = (A.y + offset.y) * scale;
  B.x = (B.x + offset.x) * scale; B.y = (B.y + offset.y) * scale;
  C.x = (C.x + offset.x) * scale; C.y = (C.y + offset.y) * scale;
  if (prim.colorMode === "flat") {
    // Flat: whole primitive uses vertex 0's color (PS1 flat3/flat4 family).
    B.r = A.r;
    B.g = A.g;
    B.b = A.b;
    C.r = A.r;
    C.g = A.g;
    C.b = A.b;
  }
  // Sort by y then x (stable span setup).
  if (B.y < A.y || (B.y === A.y && B.x < A.x)) {
    const t = A;
    A = B;
    B = t;
  }
  if (C.y < A.y || (C.y === A.y && C.x < A.x)) {
    const t = A;
    A = C;
    C = t;
  }
  if (C.y < B.y || (C.y === B.y && C.x < B.x)) {
    const t = B;
    B = C;
    C = t;
  }
  const yStart = Math.max(A.y, clip.y1);
  const yEnd = Math.min(C.y, clip.y2);
  for (let y = yStart; y <= yEnd; y++) {
    // Above B.y the active edges are A→B + A→C; below, B→C + A→C.
    const pts = (y < B.y ? edgePoints(A, B, y) : edgePoints(B, C, y)).concat(
      edgePoints(A, C, y),
    );
    if (pts.length === 0) continue;
    let L = pts[0]!;
    let R = pts[0]!;
    for (const p of pts) {
      if (p.xf < L.xf) L = p;
      if (p.xf > R.xf) R = p;
    }
    // Closed spans: left boundary ceil, right boundary floor (inclusive).
    const xL = Math.max(Math.ceil(L.xf / ONE), clip.x1);
    const xR = Math.min(Math.floor(R.xf / ONE), clip.x2);
    const den = R.xf - L.xf;
    for (let x = xL; x <= xR; x++) {
      // Linear attribute interp across the span, 16.16 fixed point.
      const num = x * ONE - L.xf;
      const lerp = (l: number, r: number): number =>
        den > 0 ? l + mulDiv(r - l, num, den) : l;
      const texel = prim.textured
        ? sampleTexel(textureVram, prim, lerp(L.uf, R.uf) >> 16, lerp(L.vf, R.vf) >> 16)
        : null;
      putPixel(
        vram,
        stride,
        prim,
        x,
        y,
        (x / scale) | 0,
        (y / scale) | 0,
        lerp(L.rf, R.rf) >> 16,
        lerp(L.gf, R.gf) >> 16,
        lerp(L.bf, R.bf) >> 16,
        texel,
      );
    }
  }
}

/** Drawing area clip from gpu registers (if present), clamped to VRAM. */
function readClip(gpu: { vram: Uint16Array }): ClipRect {
  const g = gpu as unknown as Partial<Record<string, number | undefined>>;
  const rd = (k: string, d: number): number =>
    typeof g[k] === "number" ? (g[k] as number) : d;
  const clamp = (v: number, lo: number, hi: number): number =>
    v < lo ? lo : v > hi ? hi : v;
  return {
    x1: clamp(rd("clipX1", 0), 0, 1023),
    y1: clamp(rd("clipY1", 0), 0, 511),
    x2: clamp(rd("clipX2", 1023), 0, 1023),
    y2: clamp(rd("clipY2", 511), 0, 511),
  };
}

function rasterizeInternal(
  gpu: { vram: Uint16Array },
  output: Uint16Array,
  scale: 1 | 2 | 4,
  prim: Prim,
): void {
  const nativeClip = readClip(gpu);
  if (nativeClip.x2 < nativeClip.x1 || nativeClip.y2 < nativeClip.y1) return;
  const clip = {
    x1: nativeClip.x1 * scale,
    y1: nativeClip.y1 * scale,
    x2: (nativeClip.x2 + 1) * scale - 1,
    y2: (nativeClip.y2 + 1) * scale - 1,
  };
  const offset = drawOffset(gpu);
  const stride = 1024 * scale;
  const v = prim.vertices;
  const tri = (a: PrimVert, b: PrimVert, c: PrimVert): void =>
    drawTri(output, gpu.vram, stride, scale, clip, offset, prim, a, b, c);
  if (prim.kind === "tri") {
    if (v.length < 3) return;
    tri(v[0]!, v[1]!, v[2]!);
  } else {
    // Quad: two triangles sharing the v1-v2 diagonal (PS1 decomposition).
    if (v.length < 4) return;
    tri(v[0]!, v[1]!, v[2]!);
    tri(v[1]!, v[2]!, v[3]!);
  }
}

/** Rasterize one polygon primitive into native gpu.vram (15bpp BGR555). */
export function rasterize(gpu: { vram: Uint16Array }, prim: Prim): void {
  rasterizeInternal(gpu, gpu.vram, 1, prim);
}

/**
 * Presentation-only scaled framebuffer. Native VRAM remains the sole texture
 * and game-readback source; native fills/uploads are explicitly replicated.
 */
export class HighResolutionRaster {
  readonly vram: Uint16Array;
  enhancedGeometry = false;

  constructor(private readonly nativeVram: Uint16Array, readonly scale: 2 | 4) {
    this.vram = new Uint16Array(1024 * scale * 512 * scale);
    this.invalidate();
  }

  invalidate(): void {
    const s = this.scale, width = 1024 * s;
    for (let y = 0; y < 512; y++) {
      const source = y * 1024, dest = y * s * width;
      let o = dest;
      for (let x = 0; x < 1024; x++) {
        const p = this.nativeVram[source + x]!;
        for (let dx = 0; dx < s; dx++) this.vram[o++] = p;
      }
      for (let dy = 1; dy < s; dy++) {
        const row = dest + dy * width;
        for (let x = 0; x < width; x++) this.vram[row + x] = this.vram[dest + x]!;
      }
    }
    this.enhancedGeometry = false;
  }

  writeNativePixel(x: number, y: number, color: number): void {
    const s = this.scale, width = 1024 * s;
    const left = (x & 1023) * s, top = (y & 511) * s;
    for (let dy = 0; dy < s; dy++) {
      let o = (top + dy) * width + left;
      for (let dx = 0; dx < s; dx++) this.vram[o++] = color;
    }
  }

  rasterize(gpu: { vram: Uint16Array }, prim: Prim): void {
    rasterizeInternal(gpu, this.vram, this.scale, prim);
    this.enhancedGeometry = true;
  }
}
