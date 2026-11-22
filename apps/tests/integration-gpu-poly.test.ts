import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";

/** GP0 flat triangle via CPU writes → VRAM coverage (integration gate). */
describe("GP0 polygon → rasterizer integration", () => {
  test("flat red triangle decodes and rasterizes", () => {
    const m = new Machine();
    const gp0 = (w: number) => m.gpu.writeGP0(w);
    // op 0x20: flat tri, not textured, no semi, no gouraud. words: cmd,c0,v0,v1,v2
    gp0((0x20 << 24) | 0x00f8_0000); // cmd + B=0xf8 → blue 5-bit 31 (8-bit cmd colors)
    gp0((10 | (10 << 16)) >>> 0); // v0
    gp0((60 | (10 << 16)) >>> 0);
    gp0((10 | (60 << 16)) >>> 0);
    // pixel inside triangle (x=20,y=20) must be blue 31 → 0x7c00
    expect(m.gpu.vram[20 * 1024 + 20]).toBe(0x7c00);
    // pixel outside (x=200,y=200) untouched
    expect(m.gpu.vram[200 * 1024 + 200]).toBe(0);
  });

  test("flat quad covers both diagonal halves", () => {
    const m = new Machine();
    const gp0 = (w: number) => m.gpu.writeGP0(w);
    gp0((0x28 << 24) | 0x00f8_0000); // cmd + B=0xf8 → blue 31
    gp0((10 | (10 << 16)) >>> 0);
    gp0((110 | (10 << 16)) >>> 0);
    gp0((110 | (110 << 16)) >>> 0);
    gp0((10 | (110 << 16)) >>> 0);
    // corners inside the quad
    expect(m.gpu.vram[15 * 1024 + 15]).toBe(0x7c00);
    expect(m.gpu.vram[105 * 1024 + 105]).toBe(0x7c00);
    // just outside
    expect(m.gpu.vram[115 * 1024 + 115]).toBe(0);
  });

  test("words-expected count: gouraud tri consumes 6 words", () => {
    const m = new Machine();
    m.gpu.writeGP0((0x30 << 24) | 0x00f8_0000); // cmd + c0: B=0xf8
    m.gpu.writeGP0((10 | (10 << 16)) >>> 0);
    m.gpu.writeGP0(0x03e0); // c1
    m.gpu.writeGP0((60 | (10 << 16)) >>> 0);
    m.gpu.writeGP0(0x7c00); // c2
    m.gpu.writeGP0((10 | (60 << 16)) >>> 0);
    // rasterized: interior pixel exists (blue-green mix region ok)
    expect(m.gpu.vram[30 * 1024 + 20]).not.toBe(0);
  });
});
