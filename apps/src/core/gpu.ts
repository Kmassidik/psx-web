import { rasterize, PrimVert } from "./gpu-raster";

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
      case 0x01: this.cmdWords = []; break; // clear cache: no-op
      default:
        if ((top & 0xe0) === 0x20 || (top & 0xe0) === 0x30) {
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
      default:
        // Polygon in progress: accumulate words, rasterize when complete.
        this.primWords.push(w);
        if (--this.cmdLeft === 0 && this.primWords.length > 0) {
          this.rasterizePrim(this.primWords);
        }
        break;
    }
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
          // clut base + texpage from the first texword
          this.clutBase = ((texWord >>> 16) & 0xffff) * 16;
          this.texPage = ((texWord >>> 24) & 0x1f) | (op >>> 0); // mode bits from op handled below
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

  hashFrame(): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < this.screen.length; i += 997) {
      h = ((h ^ this.screen[i]!) * 16777619) >>> 0;
    }
    return h >>> 0;
  }
}
