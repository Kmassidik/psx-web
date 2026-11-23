import { describe, expect, test } from "bun:test";
import { Machine } from "../src/core/machine";

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
    m.dma.dicr = 1 << 4;
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
    m.dma.dicr = 1 << 4;
    m.runSlice(1);
    expect(call(m, 0xb0, 0x0b, event)).toBe(1);
    expect(call(m, 0xb0, 0x0b, event)).toBe(0);
  });
});
