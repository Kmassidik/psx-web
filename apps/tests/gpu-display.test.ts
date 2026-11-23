import { describe, expect, test } from "bun:test";
import { Gpu, VRAM_W } from "../src/core/gpu.ts";

function gp1(gpu: Gpu, command: number, value = 0): void {
  gpu.writeGP1(((command << 24) | value) >>> 0);
}

interface DisplayOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  pal?: boolean;
  interlaced?: boolean;
  colorDepth?: 15 | 24;
}

function setDisplay(gpu: Gpu, options: DisplayOptions): void {
  const { width, height } = options;
  const horizontalMode = width === 320 ? 1 : width === 512 ? 2 : width === 640 ? 3 : 0;
  const cyclesPerPixel = width === 256 ? 10 : width === 320 ? 8 : width === 368 ? 7 : width === 512 ? 5 : 4;
  const mode = horizontalMode
    | (height > 256 ? 0x04 : 0)
    | (options.pal ? 0x08 : 0)
    | (options.colorDepth === 24 ? 0x10 : 0)
    | (options.interlaced ? 0x20 : 0)
    | (width === 368 ? 0x40 : 0);
  const x1 = 0x200;
  const y1 = options.pal ? 0x23 : 0x10;
  gp1(gpu, 0x08, mode);
  gp1(gpu, 0x06, (x1 | ((x1 + width * cyclesPerPixel) << 12)) >>> 0);
  gp1(gpu, 0x07, (y1 | ((y1 + height) << 10)) >>> 0);
  gp1(gpu, 0x05, ((options.x ?? 0) | ((options.y ?? 0) << 10)) >>> 0);
  gp1(gpu, 0x03, 0);
}

function setPixel(gpu: Gpu, x: number, y: number, color: number): void {
  gpu.vram[y * VRAM_W + x] = color;
}

describe("GP1 native display rectangles", () => {
  test.each([
    [256, 10],
    [320, 8],
    [368, 7],
    [512, 5],
    [640, 4],
  ] as const)("decodes %i-wide mode and its dot-clock range", (width) => {
    const gpu = new Gpu();
    setDisplay(gpu, { width, height: 240 });
    const frame = gpu.composeDisplayFrame();
    expect(frame.width).toBe(width);
    expect(frame.height).toBe(240);
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    expect(frame.rgba.length).toBe(width * 240 * 4);
  });

  test.each([
    [240, false, false],
    [256, true, false],
    [480, false, true],
    [512, true, true],
  ] as const)("uses the exact %i-line vertical range", (height, pal, interlaced) => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 320, height, pal, interlaced });
    const frame = gpu.composeDisplayFrame();
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(height);
    expect(frame.pal).toBe(pal);
    expect(frame.interlaced).toBe(interlaced);
    expect(frame.rgba.length).toBe(320 * height * 4);
  });

  test("applies hardware horizontal rounding and arbitrary vertical cropping", () => {
    const gpu = new Gpu();
    gp1(gpu, 0x08, 1); // 320-pixel dot clock
    gp1(gpu, 0x06, (0x200 | ((0x200 + 317 * 8) << 12)) >>> 0);
    gp1(gpu, 0x07, (40 | ((40 + 223) << 10)) >>> 0);
    const frame = gpu.composeDisplayFrame();
    // psx-spx: (((X2-X1)/8)+2)&~3 = (317+2)&~3 = 316.
    expect([frame.width, frame.height, frame.rgba.length]).toEqual([316, 223, 316 * 223 * 4]);
  });

  test("GP1 reset installs the documented 256x240 disabled display", () => {
    const gpu = new Gpu();
    gp1(gpu, 0x00);
    const frame = gpu.composeDisplayFrame();
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([0, 0, 256, 240]);
    expect(frame.enabled).toBe(false);
    expect(frame.pal).toBe(false);
    expect(frame.interlaced).toBe(false);
    expect(Array.from(frame.rgba.slice(0, 8))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });

  test("DMA direction and display mode are reflected in GPUSTAT", () => {
    const gpu = new Gpu();
    gp1(gpu, 0x04, 3);
    gp1(gpu, 0x08, 0x7f);
    const stat = gpu.readGPUSTAT();
    expect((stat >>> 29) & 3).toBe(3);
    expect((stat >>> 16) & 1).toBe(1);
    expect((stat >>> 17) & 3).toBe(3);
    expect((stat >>> 19) & 0x0f).toBe(0x0f);
    expect((stat >>> 23) & 1).toBe(0);
    gp1(gpu, 0x03, 1);
    expect((gpu.readGPUSTAT() >>> 23) & 1).toBe(1);
  });
});

describe("native cropped RGBA output", () => {
  test("golden 15-bit crop starts at GP1 display start, not VRAM origin", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 256, height: 240 });
    // Replace the active range with a small 8x2 golden image.
    gp1(gpu, 0x06, (0x200 | ((0x200 + 8 * 10) << 12)) >>> 0);
    gp1(gpu, 0x07, (20 | (22 << 10)) >>> 0);
    gp1(gpu, 0x05, 3 | (7 << 10));
    setPixel(gpu, 0, 0, 0x7fff);
    setPixel(gpu, 3, 7, 0x001f);
    setPixel(gpu, 4, 7, 0x03e0);
    setPixel(gpu, 5, 7, 0x7c00);
    setPixel(gpu, 6, 7, 0x7fff);
    setPixel(gpu, 3, 8, 0x0110);

    const frame = gpu.composeDisplayFrame();
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([3, 7, 8, 2]);
    expect(frame.colorDepth).toBe(15);
    expect(frame.rgba.length).toBe(8 * 2 * 4);
    expect(Array.from(frame.rgba.slice(0, 16))).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
    // R=16, G=8, B=0 expands to (132,66,0).
    expect(Array.from(frame.rgba.slice(32, 36))).toEqual([132, 66, 0, 255]);
  });

  test("display start switches framebuffer pages without a stale copy", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 320, height: 240 });
    gp1(gpu, 0x06, (0x200 | ((0x200 + 4 * 8) << 12)) >>> 0);
    gp1(gpu, 0x07, (16 | (17 << 10)) >>> 0);
    for (let x = 0; x < 4; x++) {
      setPixel(gpu, x, 0, 0x001f);
      setPixel(gpu, x, 240, 0x03e0);
    }
    const first = gpu.composeDisplayFrame();
    expect(Array.from(first.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);

    gp1(gpu, 0x05, 240 << 10);
    const second = gpu.composeDisplayFrame();
    expect(second).toBe(first);
    expect(second.y).toBe(240);
    expect(Array.from(second.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
  });

  test("interlaced 480-line output contains both field parities and the last line", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 320, height: 480, interlaced: true });
    setPixel(gpu, 0, 0, 0x001f);
    setPixel(gpu, 0, 1, 0x03e0);
    setPixel(gpu, 0, 479, 0x7c00);
    const frame = gpu.composeDisplayFrame();
    expect(Array.from(frame.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(frame.rgba.slice(320 * 4, 320 * 4 + 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(frame.rgba.slice(479 * 320 * 4, 479 * 320 * 4 + 4))).toEqual([0, 0, 255, 255]);
  });

  test("source reads wrap at VRAM edges without clipping the active rectangle", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 320, height: 240, x: 1022, y: 511 });
    gp1(gpu, 0x06, (0x200 | ((0x200 + 4 * 8) << 12)) >>> 0);
    gp1(gpu, 0x07, (16 | (18 << 10)) >>> 0);
    setPixel(gpu, 1022, 511, 0x001f);
    setPixel(gpu, 1023, 511, 0x03e0);
    setPixel(gpu, 0, 0, 0x7c00);
    setPixel(gpu, 1, 0, 0x7fff);
    const frame = gpu.composeDisplayFrame();
    expect([frame.width, frame.height]).toEqual([4, 2]);
    expect(Array.from(frame.rgba.slice(0, 16))).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    expect(Array.from(frame.rgba.slice(16, 32))).toEqual([
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
  });

  test("24-bit display mode unpacks packed RGB triplets", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 320, height: 240, x: 1, y: 2, colorDepth: 24 });
    gp1(gpu, 0x06, (0x200 | ((0x200 + 4 * 8) << 12)) >>> 0);
    gp1(gpu, 0x07, (16 | (17 << 10)) >>> 0);
    const row = 2 * VRAM_W;
    gpu.vram[row + 1] = 0x3412;
    gpu.vram[row + 2] = 0x7856;
    gpu.vram[row + 3] = 0xbc9a;
    const frame = gpu.composeDisplayFrame();
    expect(frame.colorDepth).toBe(24);
    expect(Array.from(frame.rgba.slice(0, 8))).toEqual([
      0x12, 0x34, 0x56, 255,
      0x78, 0x9a, 0xbc, 255,
    ]);
  });

  test("disabled display returns opaque black at the configured native size", () => {
    const gpu = new Gpu();
    setDisplay(gpu, { width: 368, height: 256, pal: true });
    gp1(gpu, 0x03, 1);
    const frame = gpu.composeDisplayFrame();
    expect(frame.enabled).toBe(false);
    expect([frame.width, frame.height]).toEqual([368, 256]);
    expect(Array.from(frame.rgba.slice(0, 8))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(Array.from(frame.rgba.slice(-4))).toEqual([0, 0, 0, 255]);
  });
});
