/**
 * GPU — Phase 1 stub: VRAM + the GP0 commands a PS-X EXE needs to show
 * pixels (FillVRAM 0x02, CPU→VRAM image load 0xA0/0xC0) + GP1 display config.
 * Full rasterizer (flat/gouraud/textured polygon families) lands in Phase 2.
 * VRAM: 1024×512 15bpp in one Uint16Array (preallocated; low-RAM rule).
 */
export const VRAM_W = 1024;
export const VRAM_H = 512;

export class Gpu {
  readonly vram = new Uint16Array(VRAM_W * VRAM_H);
  /** 24-bit RGBA 640×480 display output (blitted to canvas per frame). */
  readonly screen = new Uint8Array(640 * 480 * 4);
  gpur1 = 640; gpur2 = 480; // display resolution (GP1 mode)
  dispEnable = true;

  private gp0Mode = 0;
  private cmdWords: number[] = [];
  private cmdLeft = 0;
  private imgX = 0; private imgY = 0; private imgW = 0; private imgH = 0;
  private imgCur = 0;
  private fillX = 0; private fillY = 0; private fillW = 0; private fillH = 0;
  private fillColor = 0;

  /** GP0 write (port 0x1F801810). */
  writeGP0(w: number): void {
    if (this.cmdLeft > 0) { this.gp0Param(w); return; }
    this.gp0Mode = (w >>> 24) & 0xff;
    switch (this.gp0Mode) {
      case 0x02: // Fill VRAM: color, x,y, w,h
        this.cmdWords = [w]; this.cmdLeft = 4; break;
      case 0xa0: // Load image: x,y, w,h then data
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0xc0: // Store image (CPU read): x,y,w,h
        this.cmdWords = [w]; this.cmdLeft = 2; break;
      case 0x01: this.cmdWords = []; break; // clear cache: no-op
      default:
        // Polygons/lines Phase 2: consume silently, never desync.
        this.cmdWords = []; break;
    }
  }

  private gp0Param(w: number): void {
    switch (this.gp0Mode) {
      case 0x02: {
        this.cmdWords.push(w);
        if (--this.cmdLeft === 0) {
          const c = this.cmdWords[0]!;
          const x = (this.cmdWords[1]! >>> 0) & 0x3ff, y = this.cmdWords[1]! >>> 16 & 0x1ff;
          const wd = this.cmdWords[2]! & 0x3ff, ht = this.cmdWords[2]! >>> 16 & 0x1ff;
          this.fillColor = c & 0x7fff;
          this.fillRect(x, y, Math.max(1, wd), Math.max(1, ht));
        }
        break;
      }
      case 0xa0: {
        this.cmdWords.push(w);
        if (this.cmdLeft === 2 && this.cmdWords.length === 3) {
          const x = this.cmdWords[1]! & 0x3ff, y = this.cmdWords[1]! >>> 16 & 0x1ff;
          const wd = this.cmdWords[2]! & 0x3ff, ht = this.cmdWords[2]! >>> 16 & 0x1ff;
          this.imgX = x; this.imgY = y; this.imgW = wd; this.imgH = ht; this.imgCur = 0;
          this.cmdLeft = 1 + Math.ceil((wd * ht) / 2);
        } else if (--this.cmdLeft === 0) {
          // last data word(s) — handled per-word below via pushImageWord
        } else {
          this.pushImageWord(w);
        }
        break;
      }
      case 0xc0: this.cmdWords.push(w); this.cmdLeft--; break;
      default: this.cmdLeft--; break;
    }
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
      case 0x03: this.dispEnable = (w & 1) === 0; break;
      case 0x05: /* display start */ break;
      case 0x06: /* horizontal range */ break;
      case 0x07: /* vertical range */ break;
      case 0x08: {
        const mode = w & 3;
        this.gpur2 = mode === 1 ? 256 : 480; // 0:480i, 1:256, 2/3:480
        break;
      }
    }
  }

  readGPUSTAT(): number {
    return 0x1000_0000 | (this.dispEnable ? 0x0080_0000 : 0);
  }

  /** Convert current display area to RGBA for the canvas (per-frame, once). */
  composeFrame(): void {
    // Phase 1: 0,0..640x480 1:1. 15bpp → 8888.
    const s = this.screen;
    for (let y = 0; y < this.gpur2 && y < 480; y++) {
      let o = y * 640 * 4, vi = y * VRAM_W;
      for (let x = 0; x < this.gpur1 && x < 640; x++, o += 4) {
        const p = this.vram[vi + x]!;
        s[o] = (p & 31) * 8 + (p & 31) >> 2; s[o + 1] = ((p >> 5) & 31) * 8 + ((p >> 5) & 31) >> 2;
        s[o + 2] = ((p >> 10) & 31) * 8 + ((p >> 10) & 31) >> 2; s[o + 3] = 255;
      }
    }
  }

  hashFrame(): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < this.screen.length; i += 997) {
      h = ((h ^ this.screen[i]!) * 16777619) >>> 0;
    }
    return h >>> 0;
  }
}
