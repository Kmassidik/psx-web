import { describe, expect, test } from "bun:test";
import { Gpu, VRAM_W } from "../src/core/gpu.ts";
import {
  HighResolutionRaster,
  type Prim,
  type PrimVert,
  rasterize,
} from "../src/core/gpu-raster.ts";

function gp0(gpu: Gpu, word: number): void {
  gpu.writeGP0(word >>> 0);
}

function gp1(gpu: Gpu, command: number, value = 0): void {
  gpu.writeGP1((((command << 24) | value) >>> 0));
}

function setDisplay(gpu: Gpu, width = 8, height = 8): void {
  gp1(gpu, 0x08, 1); // 320-pixel horizontal dot clock
  gp1(gpu, 0x06, 0x200 | ((0x200 + width * 8) << 12));
  gp1(gpu, 0x07, 0x10 | ((0x10 + height) << 10));
  gp1(gpu, 0x05, 0);
  gp1(gpu, 0x03, 0);
}

function vertex(x: number, y: number, r = 248, g = 0, b = 0, u = 0, v = 0): PrimVert {
  return { x, y, r, g, b, u, v };
}

function primitive(over: Partial<Prim> = {}): Prim {
  return {
    kind: "tri", vertices: [], colorMode: "flat", textured: false,
    blendMode: 0, texPage: 0, clutBase: 0, dither: false, semiTrans: false,
    ...over,
  };
}

function pack(r: number, g: number, b: number): number {
  return (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
}

function drawGouraudTriangle(gpu: Gpu): void {
  gp0(gpu, 0x300000f8); // gouraud triangle, vertex 0 red
  gp0(gpu, 0 | (0 << 16));
  gp0(gpu, 0x00f800); // vertex 1 green
  gp0(gpu, 7 | (0 << 16));
  gp0(gpu, 0xf80000); // vertex 2 blue
  gp0(gpu, 0 | (7 << 16));
}

function colorSet(rgba: Uint8Array): Set<number> {
  const colors = new Set<number>();
  for (let o = 0; o < rgba.length; o += 4) {
    colors.add((rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!);
  }
  return colors;
}

describe("high internal-resolution geometric sampling", () => {
  test("explicit and implicit native composition are bit-identical goldens", () => {
    const gpu = new Gpu();
    setDisplay(gpu, 4, 4);
    // Closed-span golden: row 0 ...., row 1 .XXX, row 2 .XX., row 3 .X..
    gp0(gpu, 0x200000f8);
    gp0(gpu, 1 | (1 << 16));
    gp0(gpu, 3 | (1 << 16));
    gp0(gpu, 1 | (3 << 16));
    const implicit = gpu.composeDisplayFrame();
    const nativeRgba = implicit.rgba.slice();
    const nativeVram = gpu.vram.slice();
    const explicit = gpu.composeDisplayFrame(1);
    expect(explicit).toBe(implicit);
    expect(explicit.rgba).toEqual(nativeRgba);
    expect(gpu.vram).toEqual(nativeVram);
    expect(explicit.scale).toBe(1);
    expect(explicit.enhancedGeometry).toBe(false);
    const expectedMask = ["....", ".XXX", ".XX.", ".X.."];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const red = expectedMask[y]![x] === "X";
        expect(gpu.vram[y * VRAM_W + x]).toBe(red ? 31 : 0);
        expect(Array.from(nativeRgba.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4))).toEqual(
          red ? [255, 0, 0, 255] : [0, 0, 0, 255],
        );
      }
    }
  });

  test.each([2, 4] as const)("2x/4x gradient sampling adds detail without changing native VRAM (%ix)", (scale) => {
    const native = new Gpu(), enhanced = new Gpu();
    setDisplay(native); setDisplay(enhanced);
    drawGouraudTriangle(native);
    enhanced.composeDisplayFrame(scale); // opt in before the geometric command
    drawGouraudTriangle(enhanced);
    const nativeFrame = native.composeDisplayFrame();
    const frame = enhanced.composeDisplayFrame(scale);
    expect(enhanced.vram).toEqual(native.vram); // framebuffer/readback preservation
    expect([frame.width, frame.height]).toEqual([8 * scale, 8 * scale]);
    expect(frame.scale).toBe(scale);
    expect(frame.enhancedGeometry).toBe(true);
    expect(colorSet(frame.rgba).size).toBeGreaterThan(colorSet(nativeFrame.rgba).size);
  });

  test("4x resolves more interpolated colors than 2x, not just larger native pixels", () => {
    const two = new Gpu(), four = new Gpu();
    setDisplay(two); setDisplay(four);
    two.composeDisplayFrame(2); four.composeDisplayFrame(4);
    drawGouraudTriangle(two); drawGouraudTriangle(four);
    const twoFrame = two.composeDisplayFrame(2), fourFrame = four.composeDisplayFrame(4);
    expect(colorSet(fourFrame.rgba).size).toBeGreaterThan(colorSet(twoFrame.rgba).size);
    expect(four.vram).toEqual(two.vram);
  });

  test("native uploads remain nearest-native at 2x/4x and are not called enhanced", () => {
    for (const scale of [2, 4] as const) {
      const gpu = new Gpu();
      setDisplay(gpu, 4, 2);
      gpu.composeDisplayFrame(scale);
      gp0(gpu, 0xa0000000);
      gp0(gpu, 1 | (1 << 16));
      gp0(gpu, 2 | (1 << 16));
      gp0(gpu, 0x001f | (0x03e0 << 16));
      expect(gpu.vram[VRAM_W + 1]).toBe(0x001f);
      expect(gpu.vram[VRAM_W + 2]).toBe(0x03e0);
      const scaled = gpu.composeDisplayFrame(scale);
      expect(scaled.enhancedGeometry).toBe(false);
      const scaledCopy = scaled.rgba.slice();
      const native = gpu.composeDisplayFrame(1);
      for (let y = 0; y < scaled.height; y++) {
        for (let x = 0; x < scaled.width; x++) {
          const so = (y * scaled.width + x) * 4;
          const no = (((y / scale) | 0) * native.width + ((x / scale) | 0)) * 4;
          expect(Array.from(scaledCopy.slice(so, so + 4))).toEqual(
            Array.from(native.rgba.slice(no, no + 4)),
          );
        }
      }
    }
  });

  test("state/direct-VRAM invalidation drops enhancement until new geometry", () => {
    const gpu = new Gpu();
    setDisplay(gpu);
    gpu.composeDisplayFrame(2);
    drawGouraudTriangle(gpu);
    expect(gpu.composeDisplayFrame(2).enhancedGeometry).toBe(true);
    gpu.vram.fill(0x03e0);
    gpu.invalidateHighResolution();
    const frame = gpu.composeDisplayFrame(2);
    expect(frame.enhancedGeometry).toBe(false);
    expect(Array.from(frame.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
  });
});

describe("scaled raster semantics", () => {
  test("4bpp texture page/CLUT, signed draw offset, and inclusive clipping stay native", () => {
    const native = {
      vram: new Uint16Array(1024 * 512),
      clipX1: 1, clipY1: 1, clipX2: 5, clipY2: 5,
      drawOffsetX: 1, drawOffsetY: 0,
    };
    // Four 4bpp texels per row: indices 0,1,2,3. CLUT word 0x100 -> halfword 0x1000.
    for (let y = 0; y < 4; y++) native.vram[y * 1024 + 64] = 0x3210;
    native.vram[0x1000] = pack(31, 0, 0);
    native.vram[0x1001] = pack(0, 31, 0);
    native.vram[0x1002] = pack(0, 0, 31);
    native.vram[0x1003] = pack(31, 31, 31);
    const prim = primitive({
      kind: "quad", textured: true, texPage: 1, clutBase: 0x1000,
      vertices: [
        vertex(0, 0, 128, 128, 128, 0, 0), vertex(4, 0, 128, 128, 128, 4, 0),
        vertex(0, 4, 128, 128, 128, 0, 4), vertex(4, 4, 128, 128, 128, 4, 4),
      ],
    });
    const surface = new HighResolutionRaster(native.vram, 2);
    surface.rasterize(native, prim);
    rasterize(native, prim);
    expect(native.vram[1 * 1024 + 1]).toBe(pack(31, 0, 0));
    expect(native.vram[1 * 1024 + 2]).toBe(pack(0, 31, 0));
    expect(native.vram[1 * 1024 + 3]).toBe(pack(0, 0, 31));
    expect(native.vram[1 * 1024 + 6]).toBe(0); // outside native clip
    expect(surface.vram[2 * 2048 + 2]).toBe(pack(31, 0, 0));
    expect(surface.vram[2 * 2048 + 3]).toBe(pack(31, 0, 0));
    expect(surface.vram[2 * 2048 + 4]).toBe(pack(0, 31, 0));
    expect(surface.vram[0]).toBe(0); // outside scaled clip and draw offset
    expect(surface.vram[12 * 2048 + 12]).toBe(0);
  });

  test.each([2, 4] as const)("semi-transparent blending and dither use native backdrop/phase (%ix)", (scale) => {
    const native = { vram: new Uint16Array(1024 * 512) };
    native.vram.fill(pack(4, 4, 4));
    const surface = new HighResolutionRaster(native.vram, scale);
    const prim = primitive({
      vertices: [vertex(2, 2, 120), vertex(2, 2, 120), vertex(2, 2, 120)],
      colorMode: "gouraud",
      semiTrans: true, blendMode: 1, dither: true,
    });
    surface.rasterize(native, prim);
    rasterize(native, prim);
    // DITHER[2][2] = -4: 120-4 -> 14 five-bit, then B+F = 4+14 = 18.
    // Gouraud shading is required for dithering: no$psx applies DTD to
    // gouraud/modulated primitives and lines only (flat mono polys strip LSBs).
    const expected = pack(18, 4, 4);
    expect(native.vram[2 * 1024 + 2]).toBe(expected);
    const stride = 1024 * scale;
    expect(surface.vram[(2 * scale) * stride + 2 * scale]).toBe(expected);
  });
});
