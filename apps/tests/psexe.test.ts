import { describe, test, expect } from "bun:test";
import { parsePsExe, loadIntoRam } from "../src/core/loader/psexe";
import { Memory, RAM_SIZE } from "../src/core/memory";

/** Build a synthetic PS-X EXE image in memory (mirrors the on-disk format). */
function makeExe(t_addr: number, t_size: number, pc0: number, fill: (i: number) => number = () => 0xff): Uint8Array {
  const buf = new Uint8Array(0x800 + t_size);
  const dv = new DataView(buf.buffer);
  new TextEncoder().encodeInto("PS-X EXE", buf.subarray(0, 8));
  dv.setUint32(0x10, pc0, true);
  dv.setUint32(0x18, t_addr, true);
  dv.setUint32(0x1c, t_size, true);
  for (let i = 0; i < t_size; i++) buf[0x800 + i] = fill(i) & 0xff;
  return buf;
}

describe("PS-X EXE loader (load_psexe contract)", () => {
  test("parses header fields from correct offsets", () => {
    const exe = parsePsExe(makeExe(0x8001_0000, 0x1000, 0x8001_0000));
    expect(exe.pc0).toBe(0x8001_0000);
    expect(exe.t_addr).toBe(0x0001_0000); // normalized to RAM physical
    expect(exe.t_size).toBe(0x1000);
    expect(exe.data.byteLength).toBe(0x1000);
  });

  test("payload lands at t_addr in RAM (verify loader task)", () => {
    const mem = new Memory();
    const exe = parsePsExe(makeExe(0x8001_0000, 4, 0x8001_0000, (i) => i + 1));
    loadIntoRam(mem, exe);
    // physical offset 0x10000..0x10003 = 01 02 03 04
    expect([...mem.ram.subarray(0x1_0000, 0x1_0004)]).toEqual([1, 2, 3, 4]);
    // readable through the KSEG0 mirror too
    expect(mem.load32(0x8001_0000)).toBe(0x0403_0201);
  });

  test("rejects wrong magic", () => {
    const bad = makeExe(0x100, 4, 0x100);
    bad[0] = 0x58; // "X" not "P"
    expect(() => parsePsExe(bad)).toThrow(/magic/);
  });

  test("rejects truncated payload", () => {
    const buf = makeExe(0x100, 0x40);
    expect(() => parsePsExe(buf.subarray(0, 0x800 + 10))).toThrow(/truncated/);
  });

  test("rejects segment overflowing RAM (mirror wrap is legal, size is not)", () => {
    // t_addr wraps into the 2MiB mirror (ePSXe masks the same way), but
    // masked addr + t_size must stay inside RAM.
    expect(() => parsePsExe(makeExe(0x100, RAM_SIZE + 1, 0))).toThrow(/bad segment/);
    expect(() => parsePsExe(makeExe(0x1f_fffc, 8, 0))).toThrow(/bad segment/);
  });

  test("roundtrip: 1MiB payload loads byte-identical", () => {
    const mem = new Memory();
    const exe = parsePsExe(makeExe(0x100, RAM_1M, 0x100, (i) => i ^ (i >>> 8)));
    loadIntoRam(mem, exe);
    for (let i = 0; i < RAM_1M; i += 0xfed) expect(mem.ram[0x100 + i]).toBe((i ^ (i >>> 8)) & 0xff);
  });
});

const RAM_1M = 0x10_0000;
