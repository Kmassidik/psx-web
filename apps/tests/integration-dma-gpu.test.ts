import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";

/**
 * Cross-module property: CPU writes DMA regs → linked-list → GP0 → VRAM.
 * Mirrors the classic game render loop (list built in RAM, kicked via ch2).
 */
describe("DMA→GPU linked-list integration", () => {
  test("fill command via linked-list DMA paints VRAM green", () => {
    const m = new Machine();
    // Build a linked list in RAM at 0x1000: [next|words], then GP0 words.
    // Node: next=0xFFFFFF, 3 words: fill cmd, x/y, w/h
    m.mem.store32(0x1000, (0xffffff00 | 3) >>> 0); // next=0xFFFFFF... but head & 0x1ffffc = 0x1ff...
    // DmaUnit expects terminator as addr 0xFFFFFF; node addr field = next ptr.
    // Rebuild: header = (0xFFFFFF << 0)? per no$psx: header = next&0xFFFFFC | words<<24
    m.mem.store32(0x1000, ((0x00ff_ffff) | (3 << 24)) >>> 0);
    m.mem.store32(0x1004, 0x0200_03e0); // FillVRAM green
    m.mem.store32(0x1008, 0x0000_0000); // x=0 y=0
    m.mem.store32(0x100c, 0x0200_0400); // w=1024 h=512
    // Program ch2: base=0x1000, sync=2 (linked-list), enable + start via DPCR nibble.
    m.mem.store32(0, 0); // silence lint
    m.dma.regs[2 * 3 + 0] = 0x1000 >>> 0; // MADR
    m.dma.regs[2 * 3 + 1] = 0; // BCR unused in list mode
    m.dma.regs[2 * 3 + 2] = (0x0100_0000 | 2 << 9) >>> 0; // start + linked-list sync
    m.dma.dpcr = (m.dma.dpcr | (1 << (4 * 2 + 3))) >>> 0; // enable ch2
    m.dma.request(2);
    m.dma.run((m as any).dmaBus);
    // List walked: 3 words hit GP0 → fill executed
    expect(m.gpu.vram[0]).toBe(0x03e0);
    expect(m.gpu.vram[512 * 1024 - 1]).toBe(0x03e0);
    // IRQ line 3 raised — requires DICR master-enable (BIOS sets it; we do too)
    m.dma.writeDicr((1 << (16 + 2)) | (1 << 23)); // enable ch2 + master
    expect(m.irqStatus & (1 << 3)).not.toBe(0);
  });

  test("DMA start bit cleared after completion", () => {
    const m = new Machine();
    m.mem.store32(0x1000, ((0x00ff_ffff) | (3 << 24)) >>> 0);
    m.mem.store32(0x1004, 0x0200_7c1f);
    m.mem.store32(0x1008, 0);
    m.mem.store32(0x100c, 0x0200_0400);
    m.dma.regs[2 * 3 + 0] = 0x1000 >>> 0;
    m.dma.regs[2 * 3 + 2] = (0x0100_0000 | 2 << 9) >>> 0;
    m.dma.dpcr = (1 << (4 * 2 + 3)) >>> 0;
    m.dma.request(2);
    m.dma.run((m as any).dmaBus);
    expect((m.dma.regs[2 * 3 + 2]! & 0x0100_0000) === 0).toBe(true);
  });
});
