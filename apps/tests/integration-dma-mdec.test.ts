import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";
import { STANDARD_SCALE_TABLE } from "../src/core/mdec-tables";

function uploadTables(m: Machine): void {
  const bytes = new Uint8Array(128).fill(16);
  m.mdec.write((2 << 29) | 1);
  for (let i = 0; i < bytes.length; i += 4) {
    m.mdec.pushWord((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0);
  }
  m.mdec.write(3 << 29);
  for (let i = 0; i < 64; i += 2) {
    m.mdec.pushWord((STANDARD_SCALE_TABLE[i]! & 0xffff) | ((STANDARD_SCALE_TABLE[i + 1]! & 0xffff) << 16));
  }
}

/** Two generated 16x16 macroblocks: flat gray 192, then flat gray 64. */
function macroblockWords(): number[] {
  const halves: number[] = [];
  for (const dc of [32, -32]) {
    for (let block = 0; block < 6; block++) {
      halves.push((16 << 10) | (block < 2 ? 0 : dc & 0x3ff), 0xfe00);
    }
  }
  const words: number[] = [];
  for (let i = 0; i < halves.length; i += 2) words.push((halves[i]! | (halves[i + 1]! << 16)) >>> 0);
  return words;
}

/** Cross-module: DMA ch0 feeds MDEC0, ch1 drains every output word in order. */
describe("DMA ↔ MDEC integration", () => {
  test("real macroblocks transfer through ch0 and ch1 without dropping output", () => {
    const m = new Machine();
    uploadTables(m);
    const input = macroblockWords();
    input.forEach((w, i) => m.mem.store32(0x2000 + i * 4, w));
    const bus = {
      readRam: (a: number) => m.mem.load32(a & 0x1f_fffc),
      writeRam: (a: number, v: number) => m.mem.store32(a & 0x1f_fffc, v),
      gpuWrite: () => {},
      readVram: () => 0,
      writeVram: () => {},
      mdecIn: (w: number) => m.mdec.pushWord(w),
      mdecOut: () => m.mdec.readOutput()[0] ?? 0,
    };
    m.mdec.writeControl(0x60000000);
    m.mdec.write(((1 << 29) | (2 << 27) | input.length) >>> 0);
    m.dma.dpcr = (1 << 3) | (1 << 7);
    m.dma.regs[0] = 0x2000;
    m.dma.regs[1] = input.length;
    m.dma.regs[2] = 0x01000001; // start, burst, RAM → MDEC
    m.dma.request(0);
    m.dma.run(bus);
    expect(m.mdec.regs & 0x88000000).toBe(0x08000000); // output pending, DREQ1

    m.dma.regs[3] = 0x4000;
    m.dma.regs[4] = 384; // two RGB24 macroblocks: 2 * 768 / 4 words
    m.dma.regs[5] = 0x01000000; // start, burst, MDEC → RAM
    m.dma.request(1);
    m.dma.run(bus);
    for (let i = 0; i < 192; i++) expect(m.mem.load32(0x4000 + i * 4) >>> 0).toBe(0xc0c0c0c0);
    for (let i = 192; i < 384; i++) expect(m.mem.load32(0x4000 + i * 4) >>> 0).toBe(0x40404040);
    expect((m.mdec.regs & 0x88000000) >>> 0).toBe(0x80000000); // drained exactly, DREQ1 clear
  });
});
