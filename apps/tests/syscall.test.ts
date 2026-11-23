import { describe, expect, test } from "bun:test";
import { Machine } from "../src/core/machine";

function completeSpuDma(m: Machine): void {
  m.dma.dpcr = 0x0008_0000;
  m.dma.regs[12] = 0x1000;
  m.dma.regs[13] = 1;
  m.dma.regs[14] = 0x0100_0001;
  m.dma.request(4);
}

function call(m: Machine, table: number, fn: number, arg = 0, arg2 = 0, arg3 = 0, arg4 = 0): number {
  m.cpu.reset(table);
  m.cpu.r[9] = fn;
  m.cpu.r[4] = arg;
  m.cpu.r[5] = arg2;
  m.cpu.r[6] = arg3;
  m.cpu.r[7] = arg4;
  m.cpu.r[31] = 0x200;
  m.cpu.step();
  return m.cpu.r[2]!;
}

describe("BIOS-free kernel services", () => {
  test("InitHeap and malloc return distinct aligned heap blocks", () => {
    const m = new Machine();
    m.installHleVectors();
    call(m, 0xa0, 0x39, 0x8001_0000);
    expect(call(m, 0xa0, 0x33, 0x3400)).toBe(0x8001_0000 | 0);
    expect(call(m, 0xa0, 0x33, 1)).toBe(0x8001_3400 | 0);
    expect(call(m, 0xa0, 0x33, 1)).toBe(0x8001_3408 | 0);
  });

  test("alloc_kernel_memory returns aligned kernel blocks", () => {
    const m = new Machine();
    m.installHleVectors();
    expect(call(m, 0xb0, 0x00, 0x15)).toBe(0xa000_e000 | 0);
    expect(call(m, 0xb0, 0x00, 1)).toBe(0xa000_e018 | 0);
  });

  test("kernel allocator frees tail blocks and never exceeds its 8 KiB region", () => {
    const m = new Machine();
    m.installHleVectors();
    const first = call(m, 0xb0, 0x00, 0x20);
    expect(call(m, 0xb0, 0x01, first)).toBe(1);
    expect(call(m, 0xb0, 0x00, 0x2000)).toBe(first);
    expect(call(m, 0xb0, 0x00, 0x2000)).toBe(0);
  });

  test("GetB0Table returns callable function entries", () => {
    const m = new Machine();
    m.installHleVectors();
    const table = call(m, 0xb0, 0x57);
    expect(table).toBe(0x8000_1000 | 0);
    const openEvent = m.mem.load32(table + 0x08 * 4);
    m.cpu.reset(openEvent);
    m.cpu.r[4] = 0xf000_0009;
    m.cpu.r[5] = 0x20;
    m.cpu.r[6] = 0x2000;
    m.cpu.r[31] = 0x200;
    for (let i = 0; i < 4; i++) m.cpu.step();
    expect(m.cpu.r[2]).toBe(0xf100_0005 | 0);
  });

  test("SaveState and RestoreState preserve the saved register frame and return value", () => {
    const m = new Machine();
    m.installHleVectors();
    m.cpu.r[31] = 0x8012_3456;
    m.cpu.r[29] = 0x801f_e000;
    m.cpu.r[30] = 0x801f_d000;
    m.cpu.r[28] = 0x8000_8000;
    for (let reg = 16; reg <= 23; reg++) m.cpu.r[reg] = 0x1000 + reg;
    expect(call(m, 0xa0, 0x13, 0x4000)).toBe(0);
    expect(m.mem.load32(0x4000)).toBe(0x200);
    m.mem.store32(0x4004, 0x801f_e000);
    m.mem.store32(0x4008, 0x801f_d000);
    m.mem.store32(0x402c, 0x8000_8000);
    for (let reg = 16; reg <= 23; reg++) m.mem.store32(0x400c + (reg - 16) * 4, 0x1000 + reg);
    for (let reg = 16; reg <= 23; reg++) m.cpu.r[reg] = 0;
    m.cpu.r[28] = 0;
    m.cpu.r[29] = 0;
    m.cpu.r[30] = 0;
    expect(call(m, 0xa0, 0x14, 0x4000, 7)).toBe(7);
    expect(m.cpu.pc).toBe(0x200);
    expect(m.cpu.r[29]).toBe(0x801f_e000 | 0);
    expect(m.cpu.r[30]).toBe(0x801f_d000 | 0);
    expect(m.cpu.r[28]).toBe(0x8000_8000 | 0);
    for (let reg = 16; reg <= 23; reg++) expect(m.cpu.r[reg]).toBe(0x1000 + reg);
  });

  test("BIOS timer functions program mode, read/restart counters, and update IRQ masks", () => {
    const m = new Machine();
    m.installHleVectors();
    expect(call(m, 0xb0, 0x02, 1, 42, 0)).toBe(1);
    expect(m.rcnt.regs[5]).toBe(42);
    expect(m.rcnt.regs[4]).toBe(0x148);
    expect(call(m, 0xb0, 0x03, 1)).toBe(0);
    expect(call(m, 0xb0, 0x04, 0)).toBe(1);
    expect(m.irqMask & 0x10).toBe(0x10);
    expect(call(m, 0xb0, 0x04, 3)).toBe(0);
    expect(m.irqMask & 1).toBe(1);
    expect(call(m, 0xb0, 0x05, 0)).toBe(1);
    expect(m.irqMask & 0x10).toBe(0);
    m.rcnt.regs[3] = 99;
    expect(call(m, 0xb0, 0x06, 1)).toBe(1);
    expect(m.rcnt.regs[3]).toBe(0);
  });

  test("SPU DMA channel 4 completion delivers the SPU event", () => {
    const m = new Machine();
    m.installHleVectors();
    const event = call(m, 0xb0, 0x08, 0xf000_0009, 0x20, 0x2000, 0);
    call(m, 0xb0, 0x0c, event);
    completeSpuDma(m);
    m.runSlice(1);
    expect(call(m, 0xb0, 0x0b, event)).toBe(1);
  });

  test("cache, console write, CD cleanup, and RCNT clear services return documented results", () => {
    const m = new Machine();
    m.installHleVectors();
    expect(call(m, 0xa0, 0x44)).toBe(0);
    expect(call(m, 0xa0, 0x72)).toBe(0);
    expect(call(m, 0xb0, 0x35, 1, 0x8001_0000, 16)).toBe(16);
    expect(call(m, 0xb0, 0x35, 3, 0x8001_0000, 16)).toBe(-1);
    m.irqStatus = 0x10;
    expect(call(m, 0xc0, 0x0a, 0, 0)).toBe(0);
    expect(m.irqStatus & 0x10).toBe(0);
  });

  test("legacy pad reads active-low X and direction buttons", () => {
    const m = new Machine();
    m.installHleVectors();
    expect(call(m, 0xb0, 0x15, 0x2000_0001, 0x400)).toBe(2);
    expect(call(m, 0xb0, 0x16)).toBe(-1);
    m.pads.pad1 = 0xffff & ~0x40;
    expect(call(m, 0xb0, 0x16) & 0xffff).toBe(0xffbf);
    expect(m.mem.load32(0x400) & 0xffff).toBe(0xffbf);
  });

  test("VBlank delivery marks a registered VBlank event ready", () => {
    const m = new Machine();
    m.installHleVectors();
    const event = call(m, 0xb0, 0x08, 0xf200_0003, 0x02, 0x2000);
    call(m, 0xb0, 0x0c, event);
    m.cpu.reset(0x8003_0000);
    m.runSlice(563_000);
    expect(call(m, 0xb0, 0x0b, event)).toBe(1);
  });

  test("CDROM acknowledgement does not mark transfer completion", () => {
    const m = new Machine();
    m.installHleVectors();
    m.cdrom.write(0, 1);
    m.cdrom.write(1, 0x01);
    expect(call(m, 0xb0, 0x0b, 0xf100_0000 | 0)).toBe(0);
  });

  test("draining the sector marks the CDROM completion event ready", () => {
    const m = new Machine();
    m.installHleVectors();
    m.cdrom.setSectorData(new Uint8Array(2352));
    m.cdrom.write(0, 0);
    m.cdrom.write(3, 0x80);
    for (let i = 0; i < 512; i++) m.cdrom.readData32();
    expect(call(m, 0xb0, 0x0b, 0xf100_0000 | 0)).toBe(1);
  });

  test("callback-mode delivery executes the event function once", () => {
    const m = new Machine();
    m.installHleVectors();
    m.mem.store32(0x10000, 0x2408_0001);
    m.mem.store32(0x10004, 0xac28_0000);
    m.mem.store32(0x10008, 0x03e0_0008);
    m.mem.store32(0x1000c, 0);
    const event = call(m, 0xb0, 0x08, 0xf000_0009, 0x20, 0x1000, 0x8001_0000);
    call(m, 0xb0, 0x0c, event);
    m.cpu.r[1] = 0x500;
    completeSpuDma(m);
    m.runSlice(1);
    m["runEventCallbacks"]();
    expect(m.mem.load32(0x500)).toBe(1);
    expect(m["kernel"].takeEventCallbacks()).toEqual([]);
  });

  test("DMA-style delivery makes an enabled event ready exactly once", () => {
    const m = new Machine();
    m.installHleVectors();
    const event = call(m, 0xb0, 0x08, 0xf000_0009, 0x20, 0x2000);
    expect(event).toBe(0xf100_0005 | 0);
    expect(call(m, 0xb0, 0x0b, event)).toBe(0);
    call(m, 0xb0, 0x0c, event);
    completeSpuDma(m);
    m.runSlice(1);
    expect(call(m, 0xb0, 0x0b, event)).toBe(1);
    expect(call(m, 0xb0, 0x0b, event)).toBe(0);
  });
});
