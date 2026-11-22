import { describe, test, expect } from "bun:test";
import { Memory, translate, Region, RAM_SIZE, PARALLEL_SIZE, SCRATCHPAD_SIZE, BIOS_SIZE } from "../src/core/memory";

// ── exhaustive memory-map verification ─────────────────────────────────────
// The PS1 virtual space is fully enumerable at 64KiB granularity: 65,536 pages.
// This test pins every page to the documented region table — no sample-based
// "trust me" coverage. If translation and this table ever disagree, CI fails.

type Expect = "ram" | "parallel" | "minregs" | "bios" | "scratch" | "trap";
const PAGE = 0x1_0000;

function expectedOf(pageBase: number): Expect {
  let p = pageBase >>> 0;
  if (p >= 0xc000_0000) return "trap"; // KSEG2: unmapped (I-cache regs are sub-page)
  if (p >= 0xa000_0000) p = p - 0xa000_0000; // KSEG1: phys = va - 0xA0000000
  else if (p >= 0x8000_0000) p = p & 0x7fff_ffff; // KSEG0 mirror
  if (p < 0x0080_0000) return "ram"; // 2MiB + mirrors up to 0x00800000
  if (p === 0x1f80_0000) return "scratch";
  if (p === 0x1f80_1000) return "minregs";
  if (p >= 0x1fc0_0000 && p <= 0x1fc7_ffff) return "bios";
  if (p >= 0x1f00_0000 && p <= 0x1f7f_ffff) return "parallel";
  return "trap";
}

function gotOf(va: number): Expect {
  const { region } = translate(va);
  switch (region) {
    case Region.Ram: return "ram";
    case Region.Parallel: return "parallel";
    case Region.MinRegs: return "minregs";
    case Region.Bios: return "bios";
    case Region.Scratchpad: return "scratch";
    default: return "trap";
  }
}

test("exhaustive 64KiB page map: every page matches the documented table", () => {
  let mismatches = 0;
  for (let page = 0; page < 0x1_0000; page++) {
    const base = page * PAGE;
    const want = expectedOf(base);
    if (gotOf(base) !== want) {
      mismatches++;
      if (mismatches < 8) console.log(`KUSEG page 0x${base.toString(16)}: want ${want} got ${gotOf(base)}`);
    }
    if (base < 0x2000_0000) {
      // KSEG0/KSEG1 each cover only the low 512MiB; add, never OR (OR would
      // fold 0x20000000+ into the other segment's range).
      const b0 = (0x8000_0000 + base) >>> 0, b1 = (0xa000_0000 + base) >>> 0;
      if (gotOf(b0) !== want) { mismatches++; if (mismatches < 8) console.log(`KSEG0 0x${b0.toString(16)}: want ${want} got ${gotOf(b0)}`); }
      if (gotOf(b1) !== want) { mismatches++; if (mismatches < 8) console.log(`KSEG1 0x${b1.toString(16)}: want ${want} got ${gotOf(b1)}`); }
    }
  }
  expect(mismatches).toBe(0);
});

test("KUSEG/KSEG0/KSEG1 identity: same phys offset, same region+data", () => {
  const mem = new Memory();
  mem.store32(0x1234, 0xdeadbeef);
  expect(mem.load32(0x8000_1234)).toBe(0xdeadbeef);
  expect(mem.load32(0xa000_1234)).toBe(0xdeadbeef);
  // mirrors repeat every 2MiB
  expect(mem.load32(0x0040_1234)).toBe(0xdeadbeef);
  expect(mem.load32(0xa060_1234)).toBe(0xdeadbeef);
});

test("init defaults mirror init_psx_memory: RAM 0, parallel 0xff, others 0", () => {
  const mem = new Memory();
  expect(mem.ram.every((b) => b === 0)).toBe(true);
  expect(mem.parallel.every((b) => b === 0xff)).toBe(true);
  expect(mem.scratchpad.every((b) => b === 0)).toBe(true);
  expect(mem.ram.byteLength).toBe(RAM_SIZE);
  expect(mem.parallel.byteLength).toBe(PARALLEL_SIZE);
  expect(mem.scratchpad.byteLength).toBe(SCRATCHPAD_SIZE);
  expect(mem.bios.byteLength).toBe(BIOS_SIZE);
});

test("BIOS is read-only through the bus; scratchpad is writable", () => {
  const mem = new Memory();
  mem.bios[0] = 0x42;
  expect(mem.load8(0xbfc0_0000)).toBe(0x42);
  mem.store32(0xbfc0_0000, 0xffffffff);
  expect(mem.load8(0xbfc0_0000)).toBe(0x42);
  mem.store32(0x1f80_0000, 0x12345678);
  expect(mem.load32(0x1f80_0000)).toBe(0x12345678);
});

test("endianness: little-endian 32-bit composition", () => {
  const mem = new Memory();
  mem.store32(0x100, 0x0a0b0c0d);
  expect([mem.ram[0x100], mem.ram[0x101], mem.ram[0x102], mem.ram[0x103]]).toEqual([0x0d, 0x0c, 0x0b, 0x0a]);
});

test("trap pages return 0 and never fault", () => {
  const mem = new Memory();
  expect(mem.load32(0x4000_0000)).toBe(0);
  expect(mem.load32(0xfffe_0000)).toBe(0); // KSEG2 I-cache ctrl: trap region
  expect(mem.load8(0x1234_5678)).toBe(0);
});
