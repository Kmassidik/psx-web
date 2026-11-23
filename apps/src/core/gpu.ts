import { rasterize, PrimVert } from "./gpu-raster";

/**
 * GPU — Phase 1 stub: VRAM + the GP0 commands a PS-X EXE needs to show
 * pixels (FillVRAM 0x02, CPU→VRAM image load 0xA0/0xC0) + GP1 display config.
 * Full rasterizer (flat/gouraud/textured polygon families) lands in Phase 2.
 * VRAM: 1024×512 15bpp in one Uint16Array (preallocated; low-RAM rule).
 */
export const VRAM_W = 1024;
export const VRAM_H = 512;

/** Native active display rectangle and its tightly packed RGBA8888 pixels. */
export interface GpuDisplayFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
  readonly interlaced: boolean;
  readonly pal: boolean;
  readonly colorDepth: 15 | 24;
  readonly rgba: Uint8Array;
}

interface MutableGpuDisplayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  interlaced: boolean;
  pal: boolean;
  colorDepth: 15 | 24;
  rgba: Uint8Array;
}

export class Gpu {
  readonly vram = new Uint16Array(VRAM_W * VRAM_H);
  /** 24-bit RGBA 640×480 display output (blitted to canvas per frame). */
  readonly screen = new Uint8Array(640 * 480 * 4);
  gpur1 = 640; gpur2 = 480; // active display size (legacy composeFrame output)
  dispEnable = true;

  // Keep the original power-on shape for composeFrame compatibility. GP1(00h)
  // below installs the hardware reset values before software configures video.
  private displayMode = 0x07;
  private dmaDirection = 0;
  private horizontalStart = 0;
  private horizontalEnd = 640 * 4;
  private verticalStart = 0;
  private verticalEnd = 480;
  private readonly display: MutableGpuDisplayFrame = {
    x: 0, y: 0, width: 640, height: 480,
    enabled: true, interlaced: false, pal: false, colorDepth: 15,
    rgba: new Uint8Array(0),
  };

  private gp0Mode = 0;
  private cmdWords: number[] = [];
  private cmdLeft = 0;
  /** Accumulated words for the polygon currently being decoded. */
  private primWords: number[] = [];
  /** Texture state from the first vertex of textured prims. */
  private texPage = 0;
  private clutBase = 0;
  private imgX = 0; private imgY = 0; private imgW = 0; private imgH = 0;
  private imgCur = 0;
  private fillX = 0; private fillY = 0; private fillW = 0; private fillH = 0;
  private fillColor = 0;

  /** GP0 write (port 0x1F801810). */
  writeGP0(w: number): void {
    if (this.cmdLeft > 0) { this.gp0Param(w); return; }
    this.gp0Mode = (w >>> 24) & 0xff;
    // Polygon opcode bits (no$psx): 24-27 opcode, 27 semi-trans, 28+29-30
    // shape/vertex split... actual: bit27 semi, bit28 poly type, 29-30 verts,
    // bit31 textured. Word counts: tri=3(+1 tex palette), quad=4(+1), plus
    // 4/6 vertex words (textured adds texcache words per vertex).
    const top = this.gp0Mode;
    switch (top) {
      case 0x02: // Fill VRAM
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xa0: // Load image
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xc0: // Store image
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xe1: this.texPage = w & 0xffff; break; // draw mode / texture page
      case 0x01: this.cmdWords = []; break; // clear cache: no-op
      default:
        if ((top & 0xe0) === 0x60) {
          const textured = (top & 0x04) !== 0;
          const variableSize = ((top >>> 3) & 3) === 0;
          const total = 2 + (textured ? 1 : 0) + (variableSize ? 1 : 0);
          this.cmdWords = [w];
          this.cmdLeft = total - 1;
        } else if ((top & 0xe0) === 0x20 || (top & 0xe0) === 0x30) {
          // Polygons 20h..3Fh: decode expected total words (no$psx).
          const quad = (top & 0x08) !== 0; // bit3: 0=tri 1=quad
          const textured = (top & 0x04) !== 0; // bit2
          const gouraud = (top & 0x10) !== 0; // bit4
          const nVert = quad ? 4 : 3;
          // no$psx word layout: vertex-0 color rides in the command word
          // (flat AND gouraud); gouraud appends nVert-1 color words, each
          // AFTER its position word.
          const colorWords = gouraud ? nVert - 1 : 0;
          const total = 1 + nVert + colorWords + (textured ? nVert : 0);
          this.primWords = [w];
          this.cmdLeft = total - 1;
        } else {
          this.cmdWords = []; break;
        }
    }
  }

  private gp0Param(w: number): void {
    if ((this.gp0Mode & 0xe0) === 0x60) {
      this.cmdWords.push(w);
      if (--this.cmdLeft === 0) this.rasterizeRect(this.cmdWords);
      return;
    }
    switch (this.gp0Mode) {
      case 0x02: {
        this.cmdWords.push(w);
        if (--this.cmdLeft === 0) {
          const c = this.cmdWords[0]!;
          const x = (this.cmdWords[1]! >>> 0) & 0x3ff, y = this.cmdWords[1]! >>> 16 & 0x1ff;
          // no$psx FillVRAM: w = bits0-9, h = bits16-25; 0 means max (1024/512).
          const wd = this.cmdWords[2]! & 0x3ff || 0x400;
          const ht = (this.cmdWords[2]! >>> 16) & 0x1ff || 0x200;
          this.fillColor = c & 0x7fff;
          this.fillRect(x, y, wd, ht);
        }
        break;
      }
      case 0xa0: {
        this.cmdWords.push(w);
        if (this.cmdWords.length === 3) {
          const x = this.cmdWords[1]! & 0x3ff, y = this.cmdWords[1]! >>> 16 & 0x1ff;
          const wd = this.cmdWords[2]! & 0x3ff, ht = this.cmdWords[2]! >>> 16 & 0x1ff;
          this.imgX = x; this.imgY = y; this.imgW = wd; this.imgH = ht; this.imgCur = 0;
          this.cmdLeft = Math.ceil((wd * ht) / 2);
        } else {
          this.pushImageWord(w);
          this.cmdLeft--;
        }
        break;
      }
      case 0xc0: this.cmdWords.push(w); this.cmdLeft--; break;
      default:
        // Polygon in progress: accumulate words, rasterize when complete.
        this.primWords.push(w);
        if (--this.cmdLeft === 0 && this.primWords.length > 0) {
          this.rasterizePrim(this.primWords);
        }
        break;
    }
  }

  private rasterizeRect(words: number[]): void {
    const op = words[0]!;
    const top = (op >>> 24) & 0xff;
    const textured = (top & 0x04) !== 0;
    const sizeCode = (top >>> 3) & 3;
    const pos = words[1]!;
    const x = (pos & 0xffff) << 16 >> 16;
    const y = (pos >>> 16) << 16 >> 16;
    let wi = 2;
    let u = 0, v = 0;
    if (textured) {
      const texWord = words[wi++]!;
      u = texWord & 0xff;
      v = (texWord >>> 8) & 0xff;
      this.clutBase = ((texWord >>> 16) & 0xffff) * 16;
    }
    let width = 1, height = 1;
    if (sizeCode === 0) {
      const size = words[wi]!;
      width = size & 0x3ff;
      height = (size >>> 16) & 0x1ff;
    } else {
      width = height = sizeCode === 2 ? 8 : sizeCode === 3 ? 16 : 1;
    }
    const r = op & 0xff, g = (op >>> 8) & 0xff, b = (op >>> 16) & 0xff;
    const vertex = (vx: number, vy: number, vu: number, vv: number) => ({ x: vx, y: vy, r, g, b, u: vu, v: vv });
    rasterize(this, {
      kind: "quad",
      vertices: [
        vertex(x, y, u, v),
        vertex(x + width, y, u + width, v),
        vertex(x, y + height, u, v + height),
        vertex(x + width, y + height, u + width, v + height),
      ],
      colorMode: "flat",
      textured,
      blendMode: 0,
      texPage: this.texPage,
      clutBase: this.clutBase,
      dither: false,
      semiTrans: (top & 0x02) !== 0,
    });
  }

  /** Decode accumulated GP0 polygon words → Prim → rasterize into VRAM. */
  private rasterizePrim(words: number[]): void {
    const op = words[0]!;
    const top = (op >>> 24) & 0xff;
    const quad = (top & 0x08) !== 0;
    const textured = (top & 0x04) !== 0;
    const semiTrans = (top & 0x02) !== 0;
    const gouraud = (top & 0x10) !== 0;
    const n = quad ? 4 : 3;
    const verts: PrimVert[] = [];
    let wi = 1;
    for (let i = 0; i < n; i++) {
      // Color source: flat → command word (bits 0-23). Gouraud → vertex 0
      // rides in the command word; vertices 1..n-1 read the preceding word
      // (each position word is followed by its color word).
      const colorWord = gouraud && i > 0 ? words[wi++]! : words[0]!;
      const posWord = words[wi++]!;
      let u = 0, v = 0;
      if (textured) {
        const texWord = words[wi++]!;
        u = texWord & 0xff;
        v = (texWord >>> 8) & 0xff;
        if (i === 0) {
          this.clutBase = ((texWord >>> 16) & 0xffff) * 16;
        } else if (i === 1) {
          this.texPage = (texWord >>> 16) & 0xffff;
        }
      }
      verts.push({
        x: (posWord & 0xffff) << 16 >> 16,
        y: (posWord >>> 16) << 16 >> 16,
        r: (colorWord >>> 0) & 0xff,
        g: (colorWord >>> 8) & 0xff,
        b: (colorWord >>> 16) & 0xff,
        u, v,
      });
    }
    rasterize(this, {
      kind: quad ? "quad" : "tri",
      vertices: verts,
      colorMode: gouraud ? "gouraud" : "flat",
      textured,
      blendMode: 0,
      texPage: this.texPage,
      clutBase: this.clutBase,
      dither: false,
      semiTrans,
    });
    this.primWords = [];
  }

  private pushImageWord(w: number): void {
    for (let k = 0; k < 2; k++) {
      const px = k === 0 ? w & 0x7fff : (w >>> 16) & 0x7fff;
      const i = this.imgCur++;
      const px_ = i % this.imgW, py = (i / this.imgW) | 0;
      if (py < this.imgH) this.vram[((this.imgY + py) & 511) * VRAM_W + ((this.imgX + px_) & 1023)] = px;
    }
  }

  private fillRect(x: number, y: number, w: number, h: number): void {
    for (let yy = 0; yy < h; yy++) {
      const row = ((y + yy) & 511) * VRAM_W;
      for (let xx = 0; xx < w; xx++) this.vram[row + ((x + xx) & 1023)] = this.fillColor;
    }
  }

  /** GP1 write (port 0x1F801814): display control. */
  writeGP1(w: number): void {
    switch ((w >>> 24) & 0xff) {
      case 0x00:
        this.gp0Mode = 0;
        this.cmdWords = [];
        this.primWords = [];
        this.cmdLeft = 0;
        this.texPage = 0;
        this.clutBase = 0;
        this.dispEnable = false;
        this.dmaDirection = 0;
        this.displayMode = 0;
        this.display.x = 0;
        this.display.y = 0;
        this.horizontalStart = 0x200;
        this.horizontalEnd = 0x200 + 256 * 10;
        this.verticalStart = 0x10;
        this.verticalEnd = 0x10 + 240;
        this.updateDisplayRectangle();
        break;
      case 0x01:
        this.gp0Mode = 0;
        this.cmdWords = [];
        this.primWords = [];
        this.cmdLeft = 0;
        break;
      case 0x03:
        this.dispEnable = (w & 1) === 0;
        this.display.enabled = this.dispEnable;
        break;
      case 0x04: this.dmaDirection = w & 3; break;
      case 0x05:
        this.display.x = w & 0x3ff;
        this.display.y = (w >>> 10) & 0x1ff;
        break;
      case 0x06:
        this.horizontalStart = w & 0xfff;
        this.horizontalEnd = (w >>> 12) & 0xfff;
        this.updateDisplayRectangle();
        break;
      case 0x07:
        this.verticalStart = w & 0x3ff;
        this.verticalEnd = (w >>> 10) & 0x3ff;
        this.updateDisplayRectangle();
        break;
      case 0x08:
        this.displayMode = w & 0xff;
        this.updateDisplayRectangle();
        break;
    }
  }

  readGPUSTAT(): number {
    const mode = this.displayMode;
    return (0x1c00_0000
      | (this.dmaDirection << 29)
      | (this.dispEnable ? 0 : 0x0080_0000)
      | ((mode & 0x80) << 7)
      | ((mode & 0x40) << 10)
      | ((mode & 0x03) << 17)
      | ((mode & 0x3c) << 17)) >>> 0;
  }

  private updateDisplayRectangle(): void {
    const mode = this.displayMode;
    const baseWidth = [256, 320, 512, 640][mode & 3]!;
    const nominalWidth = (mode & 0x40) !== 0 ? 368 : baseWidth;
    const cyclesPerPixel = nominalWidth === 256 ? 10
      : nominalWidth === 320 ? 8
        : nominalWidth === 368 ? 7
          : nominalWidth === 512 ? 5 : 4;
    const horizontalRange = Math.max(0, this.horizontalEnd - this.horizontalStart);
    const verticalRange = Math.max(0, this.verticalEnd - this.verticalStart);
    // psx-spx GP1(06h/07h): horizontal size is rounded to four pixels;
    // vertical size is the exact scanline range, with no rounding.
    const width = (Math.floor(horizontalRange / cyclesPerPixel) + 2) & ~3;
    const height = verticalRange;
    this.gpur1 = width;
    this.gpur2 = height;
    this.display.width = width;
    this.display.height = height;
    this.display.enabled = this.dispEnable;
    this.display.interlaced = (mode & 0x20) !== 0;
    this.display.pal = (mode & 0x08) !== 0;
    this.display.colorDepth = (mode & 0x10) !== 0 ? 24 : 15;
  }

  /** Convert current display area to RGBA for the canvas (per-frame, once). */
  composeFrame(): void {
    // Phase 1: 0,0..640x480 1:1. 15bpp BGR → 8888 RGBA, 5→8 bit expand.
    const s = this.screen;
    for (let y = 0; y < this.gpur2 && y < 480; y++) {
      let o = y * 640 * 4, vi = y * VRAM_W;
      for (let x = 0; x < this.gpur1 && x < 640; x++, o += 4) {
        const p = this.vram[vi + x]!;
        const r5 = p & 31, g5 = (p >> 5) & 31, b5 = (p >> 10) & 31;
        s[o] = (r5 << 3) | (r5 >> 2);
        s[o + 1] = (g5 << 3) | (g5 >> 2);
        s[o + 2] = (b5 << 3) | (b5 >> 2);
        s[o + 3] = 255;
      }
    }
  }

  /**
   * Compose the native GP1 active rectangle. The returned object and pixel
   * buffer are reused; callers must consume/copy rgba before the next frame.
   * Interlaced modes return both fields as one complete framebuffer image, so
   * presentation cannot retain a stale field when its cadence differs from
   * emulated vertical sync.
   */
  composeDisplayFrame(): Readonly<GpuDisplayFrame> {
    const d = this.display;
    const size = d.width * d.height * 4;
    if (d.rgba.length !== size) d.rgba = new Uint8Array(size);
    const s = d.rgba;
    if (!d.enabled) {
      s.fill(0);
      for (let o = 3; o < s.length; o += 4) s[o] = 255;
      return d;
    }

    for (let y = 0; y < d.height; y++) {
      const sourceY = (d.y + y) & (VRAM_H - 1);
      const row = sourceY * VRAM_W;
      let o = y * d.width * 4;
      if (d.colorDepth === 24) {
        for (let x = 0; x < d.width; x++, o += 4) {
          // 24-bit display pixels are packed RGB byte triplets in VRAM;
          // GP1(05h).x remains a halfword address in this mode.
          const byteOffset = d.x * 2 + x * 3;
          const sourceX = (byteOffset >>> 1) & (VRAM_W - 1);
          const nextX = (sourceX + 1) & (VRAM_W - 1);
          const lo = this.vram[row + sourceX]!;
          const hi = this.vram[row + nextX]!;
          if ((byteOffset & 1) === 0) {
            s[o] = lo & 0xff;
            s[o + 1] = lo >>> 8;
            s[o + 2] = hi & 0xff;
          } else {
            s[o] = lo >>> 8;
            s[o + 1] = hi & 0xff;
            s[o + 2] = hi >>> 8;
          }
          s[o + 3] = 255;
        }
      } else {
        for (let x = 0; x < d.width; x++, o += 4) {
          const sourceX = (d.x + x) & (VRAM_W - 1);
          const p = this.vram[row + sourceX]!;
          const r5 = p & 31, g5 = (p >> 5) & 31, b5 = (p >> 10) & 31;
          s[o] = (r5 << 3) | (r5 >> 2);
          s[o + 1] = (g5 << 3) | (g5 >> 2);
          s[o + 2] = (b5 << 3) | (b5 >> 2);
          s[o + 3] = 255;
        }
      }
    }
    return d;
  }

  hashFrame(): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < this.screen.length; i += 997) {
      h = ((h ^ this.screen[i]!) * 16777619) >>> 0;
    }
    return h >>> 0;
  }
}
