import { HighResolutionRaster, rasterize, Prim, PrimVert } from "./gpu-raster";

/**
 * GPU — VRAM (1024×512 15bpp, one Uint16Array; low-RAM rule) + GP0 command
 * decode (polygons 20h-3Fh, lines 40h-5Fh, rectangles 60h-7Fh, VRAM
 * transfers, E0h-E6h environment) + GP1 display config and GPUSTAT.
 * Pixel-level rasterization lives in gpu-raster.ts.
 */
export const VRAM_W = 1024;
export const VRAM_H = 512;
export type GpuRenderScale = 1 | 2 | 4;
/** Fields tests and tooling may poke directly without GP1 traffic. */
export interface GpuFrameOverride {
  x?: number; y?: number; width?: number; height?: number; rgba?: Uint8Array;
}

/** Active display rectangle and tightly packed RGBA8888 pixels. x/y are native VRAM coordinates. */
export interface GpuDisplayFrame {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly enabled: boolean; readonly interlaced: boolean; readonly pal: boolean;
  readonly colorDepth: 15 | 24; readonly rgba: Uint8Array; readonly scale: GpuRenderScale;
  /** True only when scaled geometric sampling contributes to this 15-bit frame. */
  readonly enhancedGeometry: boolean;
}

interface MutableGpuDisplayFrame {
  x: number; y: number; width: number; height: number;
  enabled: boolean; interlaced: boolean; pal: boolean; colorDepth: 15 | 24;
  rgba: Uint8Array; scale: GpuRenderScale; enhancedGeometry: boolean;
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
  /** Cached GP0(E1h).bit10 / GP0(E6h).bit0-1 for GPUSTAT. */
  private dfe = false;
  private maskSet = false;
  private maskCheck = false;
  private oddField = false;
  private dmaDirection = 0;
  private horizontalStart = 0;
  private horizontalEnd = 640 * 4;
  private verticalStart = 0;
  private verticalEnd = 480;
  private readonly display: MutableGpuDisplayFrame = {
    x: 0, y: 0, width: 640, height: 480,
    enabled: true, interlaced: false, pal: false, colorDepth: 15,
    rgba: new Uint8Array(0), scale: 1, enhancedGeometry: false,
  };
  private readonly scaledDisplay: MutableGpuDisplayFrame = {
    x: 0, y: 0, width: 640, height: 480,
    enabled: true, interlaced: false, pal: false, colorDepth: 15,
    rgba: new Uint8Array(0), scale: 2, enhancedGeometry: false,
  };
  private highResolution: HighResolutionRaster | null = null;
  clipX1 = 0; clipY1 = 0; clipX2 = 1023; clipY2 = 511;
  drawOffsetX = 0; drawOffsetY = 0;

  private gp0Mode = 0;
  private cmdWords: number[] = [];
  private cmdLeft = 0;
  /** Accumulated words for the polygon currently being decoded. */
  private primWords: number[] = [];
  /** Texture state from the first vertex of textured prims. */
  private texPage = 0;
  private clutBase = 0;
  private texWindow = 0;
  private imgX = 0; private imgY = 0; private imgW = 0; private imgH = 0;
  private imgCur = 0;
  private fillColor = 0;
  /** GP0 40h..5Fh lines: words accumulated, whether a line cmd is open. */
  private lineWords: number[] = [];
  private lineLeft = 0;

  /** GP0 write (port 0x1F801810). */
  writeGP0(w: number): void {
    // Polylines have no fixed word count: keep routing params while a line
    // is open (lineWords non-empty) even though cmdLeft is 0.
    if (this.cmdLeft > 0 || this.lineWords.length > 0) { this.gp0Param(w); return; }
    this.gp0Mode = (w >>> 24) & 0xff;
    const top = this.gp0Mode;
    switch (top) {
      case 0x02: // Fill VRAM
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xa0: // Load image
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xc0: // Store image
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xe1:
        this.texPage = w & 0x7ff;
        this.dfe = (w & 0x400) !== 0;
        break; // draw mode / texture page / dither / DFE
      case 0xe2: this.texWindow = w & 0xfffff; break; // texture window (raw)
      case 0xe3:
        this.clipX1 = w & 0x3ff; this.clipY1 = (w >>> 10) & 0x1ff; break;
      case 0xe4:
        this.clipX2 = w & 0x3ff; this.clipY2 = (w >>> 10) & 0x1ff; break;
      case 0xe5:
        this.drawOffsetX = ((w & 0x7ff) << 21) >> 21;
        this.drawOffsetY = (((w >>> 11) & 0x7ff) << 21) >> 21;
        break;
      case 0xe6:
        this.maskSet = (w & 1) !== 0;
        this.maskCheck = (w & 2) !== 0;
        break;
      case 0x01: this.cmdWords = []; break; // clear cache: no-op
      case 0x80: // Copy rectangle VRAM→VRAM: 3 params (no$psx)
        this.cmdWords = [w]; this.cmdLeft = 3; break;
      default:
        if ((top & 0xe0) === 0x40) {
          // Lines 40h..5Fh (no$psx): bit4 IIP gouraud, bit3 PLL polyline,
          // bit1 ABE. Single lines: cmd + [color,pos]×(gouraud?2:1).
          // Polylines: same rhythm, terminated by 0x50005000 (checked in
          // gp0Param; no fixed word count).
          const gouraud = (top & 0x10) !== 0;
          const polyline = (top & 0x08) !== 0;
          this.lineWords = [w];
          this.cmdLeft = polyline ? 0 : gouraud ? 3 : 2;
        } else if ((top & 0xe0) === 0x60) {
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
    if ((this.gp0Mode & 0xe0) === 0x40) {
      // Line parameters: fixed-length single lines finish via cmdLeft;
      // polylines append until the 0x50005000 terminator (or a runaway
      // safety cap — the GPU FIFO would stall long before 1M words).
      this.lineWords.push(w);
      if (this.cmdLeft > 0) {
        if (--this.cmdLeft === 0) this.rasterizeLine(this.lineWords, false);
      } else if ((w & 0xf000f000) === 0x50005000 || this.lineWords.length > 65536) {
        this.rasterizeLine(this.lineWords, true);
      }
      return;
    }
    if ((this.gp0Mode & 0xe0) === 0x60) {
      this.cmdWords.push(w);
      if (--this.cmdLeft === 0) this.rasterizeRect(this.cmdWords);
      return;
    }
    switch (this.gp0Mode) {
      case 0x02: {
        this.cmdWords.push(w);
        if (--this.cmdLeft === 0) {
          const c = this.cmdWords[0]! & 0x00ff_ffff; // color = bits 0-23; command byte already consumed
          // no$psx FillVRAM masking: Xpos AND 3F0h (halfword steps of 10h),
          // Ypos AND 1FFh.
          const x = this.cmdWords[1]! & 0x3f0, y = (this.cmdWords[1]! >>> 16) & 0x1ff;
          // Width = ((w AND 3FFh)+0Fh) AND (NOT 0Fh); Height = h AND 1FFh.
          const wd = ((this.cmdWords[2]! & 0x3ff) + 0xf) & ~0xf;
          const ht = (this.cmdWords[2]! >>> 16) & 0x1ff;
          if (wd === 0 || ht === 0) break; // no$psx: fill does NOT occur for Xsiz/Ysiz=0
          // no$psx: the fill color is 24bit RGB; the GPU converts it to the
          // 15bit fill value with bit15=0 (R=bits0-7, G=8-15, B=16-23).
          this.fillColor = ((c >>> 3) & 0x1f) | ((c >>> 6) & 0x3e0) | ((c >>> 9) & 0x7c00);
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
      case 0x80: {
        this.cmdWords.push(w);
        if (--this.cmdLeft === 0) this.copyRect();
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

  private drawPrim(prim: Prim): void {
    // The scaled pass reads the same pre-command native texture/readback VRAM.
    this.highResolution?.rasterize(this, prim);
    rasterize(this, prim);
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
    this.drawPrim({
      kind: "quad",
      vertices: [
        vertex(x, y, u, v),
        vertex(x + width, y, u + width, v),
        vertex(x, y + height, u, v + height),
        vertex(x + width, y + height, u + width, v + height),
      ],
      colorMode: "flat",
      textured,
      blendMode: ((this.texPage >>> 5) & 3) as 0 | 1 | 2 | 3,
      texPage: this.texPage,
      clutBase: this.clutBase,
      texWindow: this.texWindow,
      dither: (this.texPage & 0x200) !== 0,
      semiTrans: (top & 0x02) !== 0,
      rawTex: (op & 0x0100_0000) !== 0, // command bit 24: raw texture
      exclusiveEnd: true, // rects exclude the lower-right pixel (no$psx)
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
          this.texPage = (texWord >>> 16) & 0x7ff; // raw GP0(E1h)-shaped bits
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
    this.drawPrim({
      kind: quad ? "quad" : "tri",
      vertices: verts,
      colorMode: gouraud ? "gouraud" : "flat",
      textured,
      blendMode: ((this.texPage >>> 5) & 3) as 0 | 1 | 2 | 3,
      texPage: this.texPage,
      clutBase: this.clutBase,
      texWindow: this.texWindow,
      dither: (this.texPage & 0x200) !== 0,
      semiTrans,
      rawTex: (op & 0x0100_0000) !== 0, // command bit 24: raw texture
    });
    this.primWords = [];
  }

  /**
   * Decode accumulated GP0 line words → Prim → rasterize into VRAM.
   * Word rhythm matches polygons (no$psx): vertex 0's color rides in the
   * command word; gouraud lines carry a color word BEFORE each subsequent
   * vertex (V1, C2, V2, C3, V3...). Flat lines carry positions only.
   */
  private rasterizeLine(words: number[], polyline: boolean): void {
    const op = words[0]!;
    const top = (op >>> 24) & 0xff;
    const gouraud = (top & 0x10) !== 0;
    const semiTrans = (top & 0x02) !== 0;
    const verts: PrimVert[] = [];
    let i = 1;
    let firstVert = true;
    while (i < words.length) {
      // Terminator ((word & 0xF000F000) === 0x50005000) ends the list and
      // would otherwise be misread as a color or position word.
      if (polyline && (words[i]! & 0xf000f000) === 0x50005000) break;
      // Gouraud rhythm: vertex-0 color rides the command word; later
      // vertices carry their color word BEFORE the position word (no$psx).
      const colorWord = gouraud && !firstVert ? words[i++]! : words[0]!;
      firstVert = false;
      const posWord = words[i++]!;
      verts.push({
        x: (posWord & 0xffff) << 16 >> 16,
        y: (posWord >>> 16) << 16 >> 16,
        r: (colorWord >>> 0) & 0xff,
        g: (colorWord >>> 8) & 0xff,
        b: (colorWord >>> 16) & 0xff,
        u: 0, v: 0,
      });
    }
    if (verts.length >= 2) {
      this.drawPrim({
        kind: polyline ? "polyline" : "line",
        vertices: verts,
        colorMode: gouraud ? "gouraud" : "flat",
        textured: false,
        blendMode: ((this.texPage >>> 5) & 3) as 0 | 1 | 2 | 3,
        texPage: this.texPage,
        clutBase: this.clutBase,
        texWindow: this.texWindow,
        dither: (this.texPage & 0x200) !== 0,
        semiTrans,
        rawTex: false,
      });
    }
    this.lineWords = [];
    this.cmdLeft = 0;
  }

  private pushImageWord(w: number): void {
    for (let k = 0; k < 2; k++) {
      const px = k === 0 ? w & 0x7fff : (w >>> 16) & 0x7fff;
      const i = this.imgCur++;
      const px_ = i % this.imgW, py = (i / this.imgW) | 0;
      if (py < this.imgH) {
        const x = (this.imgX + px_) & 1023, y = (this.imgY + py) & 511;
        this.vram[y * VRAM_W + x] = px;
        this.highResolution?.writeNativePixel(x, y, px);
      }
    }
  }

  private fillRect(x: number, y: number, w: number, h: number): void {
    for (let yy = 0; yy < h; yy++) {
      const row = ((y + yy) & 511) * VRAM_W;
      for (let xx = 0; xx < w; xx++) {
        const px = (x + xx) & 1023;
        this.vram[row + px] = this.fillColor;
        this.highResolution?.writeNativePixel(px, (y + yy) & 511, this.fillColor);
      }
    }
  }

  /** GP0(80h): VRAM→VRAM copy with per-no$psx parameter masking and wrap. */
  private copyRect(): void {
    // Masking for COPY commands (no$psx): Xpos AND 3FFh, Ypos AND 1FFh,
    // Xsiz=((Xsiz-1) AND 3FFh)+1, Ysiz=((Ysiz-1) AND 1FFh)+1 (0 = max).
    const srcX = this.cmdWords[1]! & 0x3ff, srcY = this.cmdWords[1]! >>> 16 & 0x1ff;
    const dstX = this.cmdWords[2]! & 0x3ff, dstY = this.cmdWords[2]! >>> 16 & 0x1ff;
    const wd = ((this.cmdWords[3]! - 1) & 0x3ff) + 1;
    const ht = ((this.cmdWords[3]! >>> 16) - 1 & 0x1ff) + 1;
    for (let yy = 0; yy < ht; yy++) {
      const sy = (srcY + yy) & 511, dy = (dstY + yy) & 511;
      const srcRow = sy * VRAM_W, dstRow = dy * VRAM_W;
      for (let xx = 0; xx < wd; xx++) {
        const sx = (srcX + xx) & 1023, dx = (dstX + xx) & 1023;
        const p = this.vram[srcRow + sx]!;
        this.vram[dstRow + dx] = p;
        this.highResolution?.writeNativePixel(dx, dy, p);
      }
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
        this.lineWords = [];
        this.texPage = 0;
        this.clutBase = 0;
        this.clipX1 = 0; this.clipY1 = 0; this.clipX2 = 1023; this.clipY2 = 511;
        this.drawOffsetX = 0; this.drawOffsetY = 0;
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
        this.lineWords = [];
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

  toggleField(): void {
    this.oddField = !this.oddField;
  }

  readGPUSTAT(): number {
    // no$psx GP1 read layout. Display-mode fields mirror GP1(08h) bits;
    // 480-line vertical resolution is reflected only while interlaced
    // (VDS "when Bit5=1").
    const mode = this.displayMode;
    return ((this.oddField ? 0x8000_0000 : 0) | 0x1c00_0000
      | (this.dmaDirection << 29)
      | (this.dispEnable ? 0 : 0x0080_0000)
      | (this.texPage & 0x3ff)
      | (this.texPage & 0x200) // bit 9: dither enable (GP0(E1h).DTD)
      | (this.dfe ? 0x400 : 0)
      | (this.maskSet ? 0x800 : 0)
      | (this.maskCheck ? 0x1000 : 0)
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
   * Compose at native, 2x, or 4x internal resolution. Selecting a new scale
   * starts from nearest-native pixels; only subsequently rendered geometry is
   * marked enhanced. Native reads, textures, DMA, and uploads never use the
   * scaled surface.
   */
  composeDisplayFrame(scale: GpuRenderScale = 1): Readonly<GpuDisplayFrame> {
    if (scale === 1) {
      this.highResolution = null;
      return this.composeNativeDisplayFrame();
    }
    if (this.highResolution?.scale !== scale) {
      try {
        this.highResolution = new HighResolutionRaster(this.vram, scale);
      } catch {
        this.highResolution = null;
        return this.composeNativeDisplayFrame(); // scale=1 exposes unsupported fallback
      }
    }
    const native = this.composeNativeDisplayFrame();
    const d = this.display, out = this.scaledDisplay, surface = this.highResolution;
    out.x = d.x; out.y = d.y; out.width = d.width * scale; out.height = d.height * scale;
    out.enabled = d.enabled; out.interlaced = d.interlaced; out.pal = d.pal;
    out.colorDepth = d.colorDepth; out.scale = scale;
    out.enhancedGeometry = d.enabled && d.colorDepth === 15 && surface.enhancedGeometry;
    const size = out.width * out.height * 4;
    if (out.rgba.length !== size) {
      try {
        out.rgba = new Uint8Array(size);
      } catch {
        this.highResolution = null;
        return native;
      }
    }
    if (!d.enabled) {
      out.rgba.fill(0);
      for (let o = 3; o < out.rgba.length; o += 4) out.rgba[o] = 255;
      return out;
    }
    if (!out.enhancedGeometry) {
      // Fill/upload-only and packed 24-bit frames are explicitly just nearest
      // native pixels, never advertised as increased internal detail.
      for (let y = 0; y < d.height; y++) {
        for (let x = 0; x < d.width; x++) {
          const source = (y * d.width + x) * 4;
          for (let dy = 0; dy < scale; dy++) {
            let o = ((y * scale + dy) * out.width + x * scale) * 4;
            for (let dx = 0; dx < scale; dx++, o += 4) {
              out.rgba[o] = native.rgba[source]!; out.rgba[o + 1] = native.rgba[source + 1]!;
              out.rgba[o + 2] = native.rgba[source + 2]!; out.rgba[o + 3] = 255;
            }
          }
        }
      }
      return out;
    }
    const sourceStride = VRAM_W * scale;
    for (let y = 0; y < out.height; y++) {
      const row = ((d.y * scale + y) & (VRAM_H * scale - 1)) * sourceStride;
      let o = y * out.width * 4;
      for (let x = 0; x < out.width; x++, o += 4) {
        const sourceX = (d.x * scale + x) & (sourceStride - 1);
        const p = surface.vram[row + sourceX]!;
        const r5 = p & 31, g5 = (p >> 5) & 31, b5 = (p >> 10) & 31;
        out.rgba[o] = (r5 << 3) | (r5 >> 2);
        out.rgba[o + 1] = (g5 << 3) | (g5 >> 2);
        out.rgba[o + 2] = (b5 << 3) | (b5 >> 2);
        out.rgba[o + 3] = 255;
      }
    }
    return out;
  }

  /** Apply display-rectangle/pixel overrides (tests, save-state tooling). */
  applyFrameOverride(o: GpuFrameOverride): void {
    if (o.x !== undefined) this.display.x = o.x;
    if (o.y !== undefined) this.display.y = o.y;
    if (o.width !== undefined) this.display.width = o.width;
    if (o.height !== undefined) this.display.height = o.height;
    if (o.rgba !== undefined) {
      if (this.display.rgba.length !== o.rgba.length) this.display.rgba = new Uint8Array(o.rgba.length);
      this.display.rgba.set(o.rgba);
    }
    this.scaledDisplay.x = this.display.x;
    this.scaledDisplay.y = this.display.y;
    this.scaledDisplay.width = this.display.width;
    this.scaledDisplay.height = this.display.height;
  }

  /** Rebuild presentation pixels after state restore or direct native VRAM writes. */
  invalidateHighResolution(): void {
    this.highResolution?.invalidate();
  }

  /** Compose the native GP1 active rectangle; the returned buffer is reused. */
  private composeNativeDisplayFrame(): Readonly<GpuDisplayFrame> {
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
          const p = this.vram[row + ((d.x + x) & (VRAM_W - 1))]!;
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
