import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";

describe("BIOS load path (load_bios @0x433540 spec)", () => {
  test("512 KiB dump loads and CPU enters at 0xBFC00000", () => {
    const m = new Machine();
    const dump = new Uint8Array(512 * 1024);
    dump[0] = 0xff; // first BIOS byte marker
    m.loadBios(dump);
    expect(m.cpu.pc).toBe(0xbfc0_0000);
    expect(m.mem.bios[0]).toBe(0xff);
    expect(m.mem.bios[512 * 1024 - 1]).toBe(0);
  });

  test("rejects undersized dumps (no partial BIOS)", () => {
    const m = new Machine();
    expect(() => m.loadBios(new Uint8Array(100))).toThrow(/too small/);
    expect(m.mem.bios[0]).toBe(0); // BIOS buffer untouched
  });

  test("BIOS readable through KSEG1 at 0xBFC00000", () => {
    const m = new Machine();
    const dump = new Uint8Array(512 * 1024);
    dump[0] = 0x3c; dump[1] = 0x08; // first real BIOS instr = LUI
    m.loadBios(dump);
    expect(m.mem.load32(0xbfc0_0000) & 0xffff).toBe(0x083c); // LE halfword order
  });
});
