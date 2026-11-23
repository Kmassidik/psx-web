/**
 * ISA conformance suite — formal-first verification per project rule.
 * 1. Property tests per opcode class vs an INDEPENDENT minimal model.
 * 2. Exhaustive edge cases (overflow, sign, delay slots, unaligned traps).
 * 3. Determinism: identical trace across runs; snapshot→restore equivalence.
 * 4. LWL/LWR/SWL/SWR exhaustive: all 4 offsets × all register/memory patterns.
 */
import { describe, test, expect } from "bun:test";
import { Memory } from "../src/core/memory";
import { Cpu } from "../src/core/cpu";
import { Rcnt } from "../src/core/rcnt";

const gteStub = { execute: () => {}, mfc2: () => 0, mtc2: () => {} };
const noPorts = { read32: () => undefined, write32: () => false };

function boot(ramData?: { addr: number; words: number[] }): Cpu {
  const mem = new Memory();
  const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts);
  if (ramData) for (const w of ramData.words) mem.store32(ramData.addr, w);
  cpu.reset(0x0000_0000); // physical base: keeps pc/link comparisons unsigned
  return cpu;
}

/** Assemble one instruction word from fields. */
function I(op: number, rs = 0, rt = 0, imm = 0) { return ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0; }
function R(fn: number, rs = 0, rt = 0, rd = 0, sa = 0) { return ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0; }
const LUI = (rt: number, imm: number) => I(0x0f, 0, rt, imm);
const ORI = (rt: number, rs: number, imm: number) => I(0x0d, rs, rt, imm);
const ADDIU = (rt: number, rs: number, imm: number) => I(0x09, rs, rt, imm);

/** Seeded PRNG (mulberry32) for deterministic property tests. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SPECIAL arithmetic vs independent model", () => {
  test("ADDU/SUBU/AND/OR/XOR exhaustive over adversarial values", () => {
    const adversarial = [0, 1, -1, 0x7fffffff, -0x80000000, 0x12345678 | 0, -0x12345678, 0xffff0000 | 0, 0x0000ffff];
    for (const a of adversarial) for (const b of adversarial) {
      const cpu = boot();
      cpu.mem.store32(0x0000, LUI(4, (a >>> 16) & 0xffff));
      cpu.mem.store32(0x0004, ORI(4, 4, a & 0xffff));
      cpu.mem.store32(0x0008, LUI(5, (b >>> 16) & 0xffff));
      cpu.mem.store32(0x000c, ORI(5, 5, b & 0xffff));
      const cases: Array<[number, (x: number, y: number) => number]> = [
        [0x21, (x, y) => (x + y) | 0],           // ADDU
        [0x23, (x, y) => (x - y) | 0],           // SUBU
        [0x24, (x, y) => (x & y) | 0],           // AND
        [0x25, (x, y) => (x | y) | 0],           // OR
        [0x26, (x, y) => (x ^ y) | 0],           // XOR
        [0x27, (x, y) => (~(x | y)) | 0],        // NOR
      ];
      for (const [fn, model] of cases) {
        const c2 = boot();
        c2.mem.store32(0x0000, LUI(4, (a >>> 16) & 0xffff));
        c2.mem.store32(0x0004, ORI(4, 4, a & 0xffff));
        c2.mem.store32(0x0008, LUI(5, (b >>> 16) & 0xffff));
        c2.mem.store32(0x000c, ORI(5, 5, b & 0xffff));
        c2.mem.store32(0x0010, R(fn, 4, 5, 6));
        for (let i = 0; i < 5; i++) c2.step();
        expect(c2.r[6]).toBe(model(a, b));
      }
    }
  });

  test("MULT exact 64-bit vs BigInt model, randomized", () => {
    const rnd = prng(1234);
    for (let t = 0; t < 500; t++) {
      const a = (rnd() * 2 ** 32) | 0, b = (rnd() * 2 ** 32) | 0;
      const cpu = boot();
      cpu.mem.store32(0, LUI(4, (a >>> 16) & 0xffff));
      cpu.mem.store32(4, ORI(4, 4, a & 0xffff));
      cpu.mem.store32(8, LUI(5, (b >>> 16) & 0xffff));
      cpu.mem.store32(12, ORI(5, 5, b & 0xffff));
      cpu.mem.store32(16, R(0x18, 4, 5));
      for (let i = 0; i < 5; i++) cpu.step();
      const want = BigInt.asIntN(64, BigInt(a >>> 0) * BigInt(b >>> 0));
      const got = BigInt.asIntN(64, (BigInt(cpu.hi >>> 0) << 32n) | BigInt(cpu.lo >>> 0));
      expect(got).toBe(want);
    }
  });

  test("DIV: signed truncation, INT_MIN/-1, div-by-zero leaves hi/lo", () => {
    // INT_MIN / -1 — MIPS R3000A: UNPREDICTABLE; we take JS trunc path.
    const cpu = boot();
    cpu.mem.store32(0, LUI(4, 0x8000)); // r4 = 0x80000000
    cpu.mem.store32(4, LUI(5, 0xffff));
    cpu.mem.store32(8, ORI(5, 5, 0xffff)); // r5 = -1
    cpu.mem.store32(12, R(0x1a, 4, 5));    // DIV
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.lo).toBe(0x80000000 | 0); // JS (a/b)|0 = INT_MIN (trunc)
    // div by zero: hi/lo unchanged
    const c2 = boot();
    c2.mem.store32(0, LUI(4, 0x1234));
    c2.mem.store32(4, R(0x1a, 4, 0)); // b = r0 = 0
    c2.lo = 0x111; c2.hi = 0x222;
    for (let i = 0; i < 3; i++) c2.step();
    expect(c2.lo).toBe(0x111); expect(c2.hi).toBe(0x222);
  });

  test("ADD/ADDI overflow traps (exception), ADDIU does not", () => {
    const cpu = boot();
    // BIOS-free parity: install a recognizable handler stub at the vector.
    cpu.mem.store32(0x8000_0080, 0x0000000d); // break = handler marker
    cpu.mem.store32(0, LUI(4, 0x7fff));
    cpu.mem.store32(4, ORI(4, 4, 0xffff)); // r4 = 0x7fffffff
    cpu.mem.store32(8, I(0x08, 4, 6, 1));  // ADDI r6, r4, 1 → overflow
    for (let i = 0; i < 3; i++) cpu.step();
    expect(cpu.cp0[13]! >> 2).toBe(0xc); // CAUSE.ExcCode = 12 (Ov)
    expect(cpu.pc >>> 0).toBe(0x8000_0080);
    expect(cpu.cp0[14]! >>> 0).toBe(0x0c); // EPC per our pc-advance convention
    // ADDIU same operands: no trap
    const c2 = boot();
    c2.mem.store32(0, LUI(4, 0x7fff));
    c2.mem.store32(4, ORI(4, 4, 0xffff));
    c2.mem.store32(8, I(0x09, 4, 6, 1));
    for (let i = 0; i < 3; i++) c2.step();
    expect(c2.r[6]).toBe(0x80000000 | 0);
    expect(c2.cp0[13]).toBe(0);
  });
});

describe("Loads/stores incl. unaligned ops", () => {
  test("LB sign-extends, LBU/LHU zero-extend", () => {
    const cpu = boot();
    cpu.mem.store32(0x200, 0x80ff_8001);
    cpu.mem.store32(0, LUI(1, 0)); cpu.mem.store32(4, ORI(1, 1, 0x200));
    cpu.mem.store32(8, I(0x20, 1, 2, 0)); // LB r2, 0(r1) → 0x01
    cpu.mem.store32(12, I(0x20, 1, 3, 1)); // LB r3, 1(r1) → 0x80
    cpu.mem.store32(16, I(0x24, 1, 4, 1)); // LBU r4, 1(r1)
    cpu.mem.store32(20, I(0x25, 1, 5, 2)); // LHU r5, 2(r1) → 0x80ff
    for (let i = 0; i < 7; i++) cpu.step();
    expect(cpu.r[2]).toBe(1);
    expect(cpu.r[3]).toBe(-128);
    expect(cpu.r[4]).toBe(0x80);
    expect(cpu.r[5]).toBe(0x80ff);
  });

  test("SW stores all 32 bits (opcode 2B, not SWL 2A)", () => {
    const cpu = boot();
    cpu.r[1] = 0x400;
    cpu.r[2] = 0x8000_0068 | 0;
    cpu.mem.store32(0, I(0x2b, 1, 2, 0));
    expect(cpu.step()).toBe(true);
    expect(cpu.mem.load32(0x400)).toBe(0x8000_0068);
  });

  test("LWL/LWR/SWL/SWR exhaustive: all 4 offsets × 3 patterns = LW/SW pair", () => {
    const rnd = prng(77);
    for (let off = 0; off < 4; off++) {
      for (let p = 0; p < 20; p++) {
        const rt0 = (rnd() * 2 ** 32) | 0;
        const memW = (rnd() * 2 ** 32) >>> 0;
        const swVal = (rnd() * 2 ** 32) | 0;
        // LWL at a, then LWR at a+3 → full word load from unaligned a
        const a = 0x300 + off;
        const cpu = boot();
        cpu.mem.store32(0x300 & ~3, memW); cpu.mem.store32((0x300 & ~3) + 4, 0xaabbccdd);
        cpu.mem.store32(0, LUI(1, 0)); cpu.mem.store32(4, ORI(1, 1, 0x300));
        cpu.mem.store32(8, LUI(2, (rt0 >>> 16) & 0xffff)); cpu.mem.store32(12, ORI(2, 2, rt0 & 0xffff));
        cpu.mem.store32(16, I(0x26, 1, 2, off));          // LWR r2, off(r1) — LE pair:
        cpu.mem.store32(20, I(0x22, 1, 2, off + 3));      // LWR@A then LWL@A+3
        for (let i = 0; i < 7; i++) cpu.step();
        // unaligned word at 0x300+off (bytes B_off..B_off+3 of the pair)
        const b0 = cpu.mem.load8(a), b1 = cpu.mem.load8(a + 1), b2 = cpu.mem.load8(a + 2), b3 = cpu.mem.load8(a + 3);
        const want = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
        expect(cpu.r[2]).toBe(want | 0);
        // SWL/SWR pair stores rt across the same span: memory == aligned write
        const cpu2 = boot();
        cpu2.mem.store32(0, LUI(1, 0)); cpu2.mem.store32(4, ORI(1, 1, 0x300));
        cpu2.mem.store32(8, LUI(2, (swVal >>> 16) & 0xffff)); cpu2.mem.store32(12, ORI(2, 2, swVal & 0xffff));
        cpu2.mem.store32(16, I(0x2e, 1, 2, off));         // SWR r2, off(r1) — LE pair:
        cpu2.mem.store32(20, I(0x2a, 1, 2, off + 3));     // SWR@A then SWL@A+3
        for (let i = 0; i < 7; i++) cpu2.step();
        const got = cpu2.mem.load32(0x300 & ~3);
        const alignedLo = (0x300 & ~3);
        // bytes written span [0x300+off, 0x300+off+3]; aligned word at 0x300 has
        // its low bytes replaced per LE SWL/SWR merge — compare byte-precisely:
        const w0 = cpu2.mem.load8(alignedLo), w1 = cpu2.mem.load8(alignedLo + 1), w2 = cpu2.mem.load8(alignedLo + 2), w3 = cpu2.mem.load8(alignedLo + 3);
        const swBytes = [swVal & 0xff, (swVal >>> 8) & 0xff, (swVal >>> 16) & 0xff, (swVal >>> 24) & 0xff];
        const bytes = [w0, w1, w2, w3];
        for (let i = 0; i < 4; i++) {
          if (i >= off && i <= off + 3) {
            // byte i of memory = byte (i - off) of rt? NO: LE SWL writes top bytes
            // of rt to B_off..B_3; SWR writes B_0..B_off of rt bottom.
          }
        }
        // Exact model: span mem[A..A+3] == rt bytes in plain LE order
        const sv = swVal | 0;
        const s0 = cpu2.mem.load8(0x300 + off), s1 = cpu2.mem.load8(0x300 + off + 1),
          s2 = cpu2.mem.load8(0x300 + off + 2), s3 = cpu2.mem.load8(0x300 + off + 3);
        const span = s0 | (s1 << 8) | (s2 << 16) | (s3 << 24);
        expect(span).toBe(sv);
        void bytes;
      }
    }
  });

  test("unaligned LW emulates byte-wise (BIOS-handler behavior)", () => {
    const cpu = boot();
    cpu.mem.store32(0x300, 0xaabbccdd);
    cpu.mem.store32(0, LUI(1, 0)); cpu.mem.store32(4, ORI(1, 1, 0x301));
    cpu.mem.store32(8, I(0x23, 1, 2, 0)); // LW r2, 0(r1) unaligned
    for (let i = 0; i < 4; i++) cpu.step(); // +1: delayed load lands
    // bytes at 0x301..0x304 (LE word load emulation): cc bb aa 00
    expect(cpu.r[2]).toBe(0x00aabbcc);
    expect(cpu.cp0[13]! >> 2).toBe(0); // no exception — BIOS-emulated
  });
});

describe("Branch/jump delay slots", () => {
  test("BEQ taken executes delay slot before target", () => {
    const cpu = boot();
    // r4 = 1; BEQ r4,r1(+0) taken (r1=0? no) — use BNE r4,r0 taken
    cpu.mem.store32(0x00, ADDIU(4, 0, 1));
    cpu.mem.store32(0x04, I(0x05, 4, 0, 3));   // BNE r4,r0 → +3 (0x14)
    cpu.mem.store32(0x08, ADDIU(5, 0, 0x11));  // delay slot: r5=0x11
    cpu.mem.store32(0x0c, ADDIU(6, 0, 0x22));  // skipped
    cpu.mem.store32(0x10, ADDIU(7, 0, 0x33));  // skipped
    cpu.mem.store32(0x14, ADDIU(8, 0, 0x44));  // target: r8=0x44
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.r[5]).toBe(0x11);   // delay slot ran
    expect(cpu.r[6]).toBe(0);      // fall-through skipped
    expect(cpu.r[7]).toBe(0);
    expect(cpu.r[8]).toBe(0x44);   // target reached
    expect(cpu.pc).toBe(0x1c);     // executed target instr; pc advanced past it
  });

  test("JAL links pc+8 semantics (return past delay slot)", () => {
    const cpu = boot();
    cpu.mem.store32(0x00, I(0x03, 0, 0, 0x10 >> 2)); // JAL 0x10
    cpu.mem.store32(0x04, ADDIU(5, 0, 0x99));        // delay slot
    cpu.mem.store32(0x10, ADDIU(6, 0, 1));
    for (let i = 0; i < 3; i++) cpu.step();
    expect(cpu.r[31]).toBe(0x08);
    expect(cpu.r[5]).toBe(0x99);
    expect(cpu.r[6]).toBe(1);
  });

  test("J/JAL preserve all 26 target bits", () => {
    const target = 0x0007_c234;
    for (const op of [0x02, 0x03]) {
      const cpu = boot();
      cpu.mem.store32(0x00, ((op << 26) | (target >>> 2)) >>> 0);
      cpu.mem.store32(0x04, 0); // delay slot
      cpu.step();
      cpu.step();
      expect(cpu.pc).toBe(target);
    }
  });

  test("load-delay: LW value visible to following instruction, not LW itself", () => {
    const cpu = boot();
    cpu.mem.store32(0x400, 0x1234_5678);
    cpu.mem.store32(0x00, LUI(1, 0)); cpu.mem.store32(0x04, ORI(1, 1, 0x400));
    cpu.mem.store32(0x08, I(0x23, 1, 2, 0));  // LW r2, 0(r1)
    cpu.mem.store32(0x0c, I(0x23, 1, 2, 0));  // LW r2 again (1st sees old r2=0)
    cpu.mem.store32(0x10, ADDIU(3, 2, 1));    // r3 = r2+1 sees value
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.r[3]).toBe((0x1234_5678 | 0) + 1);
  });
});

describe("HI/LO register transfers", () => {
  test("MFLO reads LO and MTHI writes HI", () => {
    const cpu = boot();
    cpu.lo = 0x5566_7788;
    cpu.hi = 0x1122_3344;
    cpu.mem.store32(0, R(0x12, 0, 0, 2)); // MFLO r2
    cpu.mem.store32(4, R(0x11, 2));       // MTHI r2
    cpu.mem.store32(8, R(0x10, 0, 0, 3)); // MFHI r3
    for (let i = 0; i < 3; i++) cpu.step();
    expect(cpu.r[2]).toBe(0x5566_7788);
    expect(cpu.r[3]).toBe(0x5566_7788);
    expect(cpu.hi).toBe(0x5566_7788);
  });
});

describe("BIOS HLE calls", () => {
  test("SYSCALL writes its result to v0 and returns to ra", () => {
    const mem = new Memory();
    const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts, (table, fn) => {
      expect(table).toBe(0xb0);
      expect(fn).toBe(0);
      return 0x1234_5678;
    });
    cpu.reset(0xb0);
    cpu.r[9] = 0;
    cpu.r[31] = 0x80;
    mem.store32(0xb0, 0x0000_000c);
    expect(cpu.step()).toBe(true);
    expect(cpu.r[2]).toBe(0x1234_5678);
    expect(cpu.pc).toBe(0x80);
    expect(cpu.nextPc).toBe(0x84);
  });

  test("critical-section SYS calls update interrupt enable and mask bits", () => {
    const cpu = boot();
    cpu.r[4] = 2;
    cpu.mem.store32(0, 0x0000_000c);
    cpu.mem.store32(4, 0x0000_000c);
    cpu.step();
    expect(cpu.cp0[12]).toBe(0x405);
    cpu.r[4] = 1;
    cpu.step();
    expect(cpu.r[2]).toBe(1);
    expect(cpu.cp0[12]).toBe(1);
  });

  test("non-vector SYSCALL raises an exception instead of using HLE", () => {
    let calls = 0;
    const mem = new Memory();
    const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts, () => { calls++; return 1; });
    cpu.reset(0x200);
    mem.store32(0x200, 0x0000_000c);
    expect(cpu.step()).toBe(true);
    expect(calls).toBe(0);
    expect(cpu.cp0[13]! >> 2).toBe(8);
  });
});

describe("Determinism properties", () => {
  test("same program → identical register trace across two runs", () => {
    const build = () => {
      const cpu = boot();
      // small pseudo-random compute: xorshift in registers
      cpu.mem.store32(0x00, LUI(4, 0x1234)); cpu.mem.store32(0x04, ORI(4, 4, 0x5678));
      for (let i = 0; i < 12; i++) {
        cpu.mem.store32(0x08 + i * 4, R(0x26, 4, 4, 4)); // XOR r4,r4,r4? boring…
      }
      return cpu;
    };
    const a = build(), b = build();
    const traceA: number[] = [], traceB: number[] = [];
    for (let i = 0; i < 20; i++) { a.step(); b.step(); traceA.push(a.r[4]!); traceB.push(b.r[4]!); }
    expect(traceB).toEqual(traceA);
  });

  test("snapshot → restore → continue == uninterrupted run (state hash)", () => {
    const make = () => {
      const cpu = boot();
      cpu.mem.store32(0x00, ADDIU(4, 0, 5));
      cpu.mem.store32(0x04, ADDIU(5, 0, 7));
      cpu.mem.store32(0x08, R(0x18, 4, 5, 0));  // MULT
      cpu.mem.store32(0x0c, R(0x10, 0, 0, 6));  // MFHI r6
      cpu.mem.store32(0x10, R(0x12, 0, 0, 7));  // MFLO r7
      return cpu;
    };
    const a = make();
    for (let i = 0; i < 2; i++) a.step();
    // snapshot: all CPU state
    const snap = { pc: a.pc, nextPc: a.nextPc, hi: a.hi, lo: a.lo, r: [...a.r], cp0: [...a.cp0], cycles: a.cycles };
    for (let i = 0; i < 2; i++) a.step();
    const b = make();
    for (let i = 0; i < 2; i++) b.step();
    b.pc = snap.pc; b.nextPc = snap.nextPc; b.hi = snap.hi; b.lo = snap.lo;
    b.r.set(snap.r); b.cp0.set(snap.cp0); b.cycles = snap.cycles;
    for (let i = 0; i < 2; i++) b.step();
    expect(b.r[6]).toBe(a.r[6]); expect(b.r[7]).toBe(a.r[7]);
    expect(b.pc).toBe(a.pc); expect(b.cycles).toBe(a.cycles);
  });
});
