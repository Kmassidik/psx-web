/**
 * Dynarec tier suite — parity with the interpreter is the gate.
 * 1. Arithmetic sequences (incl. overflow edges) vs Cpu interpreter.
 * 2. LW/SW roundtrip through a stub bus (incl. LW→SW same-reg delay order).
 * 3. Branch/jump/delay-slot: taken/not-taken, JAL link, JR return.
 * 4. Cache invalidation forces re-translate.
 * 5. 1000-block compile+run benchmark.
 */
import { describe, test, expect } from "bun:test";
import { Memory } from "../src/core/memory";
import { Cpu } from "../src/core/cpu";
import { Rcnt } from "../src/core/rcnt";
import { Machine } from "../src/core/machine";
import { Dynarec, type CpuState } from "../src/core/dynarec/blocks";
import { translateBlock, BLOCK_MAX } from "../src/core/dynarec/translator";

const gteStub = { execute: () => {}, mfc2: () => 0, mtc2: () => {} };
const noPorts = { read32: () => undefined, write32: () => false };

/** Assemble one instruction word from fields. */
function I(op: number, rs = 0, rt = 0, imm = 0) { return ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0; }
function R(fn: number, rs = 0, rt = 0, rd = 0, sa = 0) { return ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0; }
const LUI = (rt: number, imm: number) => I(0x0f, 0, rt, imm);
const ORI = (rt: number, rs: number, imm: number) => I(0x0d, rs, rt, imm);
const ADDIU = (rt: number, rs: number, imm: number) => I(0x09, rs, rt, imm);
const ADDU = (rd: number, rs: number, rt: number) => R(0x21, rs, rt, rd);
const SUBU = (rd: number, rs: number, rt: number) => R(0x23, rs, rt, rd);
const AND = (rd: number, rs: number, rt: number) => R(0x24, rs, rt, rd);
const OR = (rd: number, rs: number, rt: number) => R(0x25, rs, rt, rd);
const XOR = (rd: number, rs: number, rt: number) => R(0x26, rs, rt, rd);
const NOR = (rd: number, rs: number, rt: number) => R(0x27, rs, rt, rd);
const SLL = (rd: number, rt: number, sa: number) => R(0x00, 0, rt, rd, sa);
const SRL = (rd: number, rt: number, sa: number) => R(0x02, 0, rt, rd, sa);
const SRA = (rd: number, rt: number, sa: number) => R(0x03, 0, rt, rd, sa);
const SLT = (rd: number, rs: number, rt: number) => R(0x2a, rs, rt, rd);
const SLTU = (rd: number, rs: number, rt: number) => R(0x2b, rs, rt, rd);
const SLTI = (rt: number, rs: number, imm: number) => I(0x0a, rs, rt, imm);
const SLTIU = (rt: number, rs: number, imm: number) => I(0x0b, rs, rt, imm);
const LW = (rt: number, rs: number, imm: number) => I(0x23, rs, rt, imm);
const SW = (rt: number, rs: number, imm: number) => I(0x2b, rs, rt, imm);
const BEQ = (rs: number, rt: number, off: number) => I(0x04, rs, rt, off);
const BNE = (rs: number, rt: number, off: number) => I(0x05, rs, rt, off);
const BLTZ = (rs: number, off: number) => I(0x01, rs, 0x00, off);
const BGEZ = (rs: number, off: number) => I(0x01, rs, 0x01, off);
const BGEZAL = (rs: number, off: number) => I(0x01, rs, 0x11, off);
const J = (target: number, at: number) => (0x02 << 26) | ((target >>> 2) & 0x3ff_ffff) | (at & 0xf000_0000);
const JAL = (target: number, at: number) => (0x03 << 26) | ((target >>> 2) & 0x3ff_ffff) | (at & 0xf000_0000);
const JR = (rs: number) => R(0x08, rs);
const NOP = 0x00000000; // SLL r0,r0,0

/**
 * Run `words` from `start` through BOTH engines, each executing until pc
 * reaches `end` (programs end in SW so blocks exit exactly there). Returns
 * both final states for parity comparison.
 */
function runBoth(words: number[], start: number, end: number) {
  const memA = new Memory();
  const cpuA = new Cpu(memA, new Rcnt(), gteStub, noPorts);
  cpuA.reset(start);
  for (let i = 0; i < words.length; i++) memA.store32(start + 4 * i, words[i]);

  const memB = new Memory();
  const cpuB = new Cpu(memB, new Rcnt(), gteStub, noPorts);
  cpuB.reset(start);
  for (let i = 0; i < words.length; i++) memB.store32(start + 4 * i, words[i]);
  const dyn = new Dynarec();
  const hooks = {
    read32: (va: number) => memB.load32(va) | 0,
    write32: (va: number, v: number) => void memB.store32(va, v),
    exit: () => {},
    memory: dyn.memory,
  };
  (globalThis as any).__dynDebug = true;
  let guard = 0;
  while (cpuA.pc !== end && guard++ < 1000) cpuA.step();
  if ((globalThis as any).__dynDebug) {
    console.log("cpuA end pc:", (cpuA.pc >>> 0).toString(16), "r1:", (cpuA.r[1]! >>> 0).toString(16), "steps:", guard);
    console.log("cpuA [1004]:", (memA.load32(0x1004) >>> 0).toString(16));
  }
  guard = 0;
  const state: CpuState = cpuB;
  const inCode = (pc: number) => pc >= start && pc < end;
  while (cpuB.pc !== end && inCode(cpuB.pc) && guard++ < 100) {
    if ((globalThis as any).__dynDebug) console.log("B run at pc=0x" + (cpuB.pc >>> 0).toString(16));
    dyn.run(cpuB.pc, (a) => memB.load32(a) | 0, hooks, state);
    if ((globalThis as any).__dynDebug) console.log("  → pc=0x" + (cpuB.pc >>> 0).toString(16) + " r1=0x" + (cpuB.r[1]! >>> 0).toString(16) + " r2=0x" + (cpuB.r[2]! >>> 0).toString(16));
  }
  return { cpuA, cpuB, dyn, ran: guard <= 100, memB };
}

/** Spot-check helper: value at 0x1008 of the test's Memory. */
function m2value(cpu: Cpu): number { return cpu.mem.load32(0x1008) | 0; }

function expectParity(words: number[], start: number, end: number) {
  const { cpuA, cpuB, dyn, ran, memB } = runBoth(words, start, end);
  for (let i = 0; i < 32; i++) {
    if (cpuB.r[i] !== cpuA.r[i]) {
      process.stdout.write("\n" + "r" + i + ": A=0x" + (cpuA.r[i]!>>>0).toString(16) + " B=0x" + (cpuB.r[i]!>>>0).toString(16) +
        " B[1004]=0x" + (memB.load32(0x1004)>>>0).toString(16) + " B[1000]=0x" + (memB.load32(0x1000)>>>0).toString(16) +
        " compiles=" + dyn.compiles + " Bpc=0x" + (cpuB.pc>>>0).toString(16));
    }
    expect(cpuB.r[i]).toBe(cpuA.r[i]);
  }
  expect(cpuB.pc).toBe(cpuA.pc);
  expect(cpuB.nextPc).toBe(cpuA.nextPc);
  if (cpuB.hi !== cpuA.hi) console.log(`hi: A=${(cpuA.hi>>>0).toString(16)} B=${(cpuB.hi>>>0).toString(16)}`);
  if (cpuB.lo !== cpuA.lo) console.log(`lo: A=${(cpuA.lo>>>0).toString(16)} B=${(cpuB.lo>>>0).toString(16)} pc A=${(cpuA.pc>>>0).toString(16)} B=${(cpuB.pc>>>0).toString(16)}`);
  expect(cpuB.hi).toBe(cpuA.hi);
  expect(cpuB.lo).toBe(cpuA.lo);
  if (ran) expect(cpuB.cycles).toBe(cpuA.cycles);
  expect(dyn.compiles).toBeGreaterThan(0);
  return { cpuA, cpuB };
}

describe("arithmetic parity vs interpreter", () => {
  const start = 0x0;
  const prog = [
    LUI(1, 0x1234), ORI(1, 1, 0x5678), // r1 = 0x12345678
    LUI(2, 0x7fff), ORI(2, 2, 0xffff), // r2 = 0x7fffffff
    ADDIU(2, 2, 1), // wrap to 0x80000000 (ADDU semantics, no trap)
    LUI(3, 0xffff), ORI(3, 3, 0xffff), // r3 = -1
    SUBU(4, 2, 3), // 0x80000000 - (-1) = 0x80000001
    SLL(5, 3, 31), // 0x80000000
    SRL(6, 5, 31), // logical → 1
    SRA(7, 5, 31), // arithmetic → -1
    ADDU(8, 3, 3), // -2
    AND(9, 1, 3), OR(10, 1, 2), XOR(11, 1, 3), NOR(12, 1, 3),
    SLT(13, 3, 1), // signed: -1 < 1 → 1
    SLTU(14, 3, 1), // unsigned: 0xffffffff < 1 → 0
    SLTI(15, 3, 0), SLTIU(16, 3, 0), // 1 and 0
    SW(1, 0, 0x100), // block end marker
  ];
  const end = start + 4 * prog.length;
  test("sequence with wraparound/shift/compare edges matches interpreter", () => {
    const { cpuA } = expectParity(prog, start, end);
    expect(cpuA.r[1]! >>> 0).toBe(0x1234_5678);
    expect(cpuA.r[2]! >>> 0).toBe(0x8000_0000);
    expect(cpuA.r[4]! >>> 0).toBe(0x8000_0001);
    expect(cpuA.r[6]).toBe(1);
    expect(cpuA.r[7]).toBe(-1);
    expect(cpuA.r[13]).toBe(1);
    expect(cpuA.r[14]).toBe(0);
    expect(cpuA.r[15]).toBe(1);
    expect(cpuA.r[16]).toBe(0);
  });

  test("block cap: fetches never exceed BLOCK_MAX", () => {
    let fetches = 0;
    translateBlock(() => { fetches++; return NOP; }, 0);
    expect(fetches).toBeLessThanOrEqual(BLOCK_MAX);
    expect(fetches).toBeGreaterThan(1);
  });

  test("unsupported opcode (MULT) throws with the offending pc", () => {
    expect(() => translateBlock(() => R(0x18, 1, 2, 3), 0x40)).toThrow(/unsupported SPECIAL fn 0x18/);
  });
});

describe("LW/SW roundtrip via stub bus", () => {
  test("store→load→store matches interpreter (incl. LW→SW same-reg order)", () => {
    const start = 0x100;
    const prog = [
      LUI(1, 0x0add), ORI(1, 1, 0x0001),
      SW(1, 0, 0x1000), // block ends (store boundary)
      LW(2, 0, 0x1000), // new block: load it back
      SW(2, 0, 0x1004), // block ends; also LW value lands before SW reads r2? no — r2 lands at exit
      LW(1, 0, 0x1004), // r1 ← [0x1004] (overwrites), lands before ADDIU below
      ADDIU(1, 1, 1),
      SW(1, 0, 0x1008),
    ];
    const end = start + 4 * prog.length;
    const { cpuA, cpuB } = expectParity(prog, start, end);
    // Load-delay truth: SW(2,0,1004) at idx4 reads r2 while LW(2,...) is still
    // in flight → stores 0; LW(1,1004) then loads 0; ADDIU lands next slice.
    // Both engines must agree bit-for-bit (that IS the parity gate).
    expect(cpuA.r[1]).toBe(cpuB.r[1]);
    expect(m2value(cpuA)).toBe(m2value(cpuB));
  });
});

describe("branch/jump/delay-slot parity", () => {
  test("BEQ taken and not-taken (both programs)", () => {
    // taken: BEQ r0,r0 → skip the LUI poison, land on final SW
    const taken = [
      BEQ(0, 0, 1), LUI(1, 0xbad), // delay slot executes regardless
      SW(1, 0, 0x200), // branch target (skips nothing else)
    ];
    expectParity(taken, 0x300, 0x300 + 4 * taken.length);
    // not-taken: BEQ r1,r0 with r1 != 0 → fall through, then SW
    const notTaken = [
      LUI(1, 0), ADDIU(1, 1, 1),
      BEQ(1, 0, 1), LUI(2, 0x0dd),
      ADDIU(2, 2, 5), // falls through: executes
      SW(2, 0, 0x204),
    ];
    expectParity(notTaken, 0x400, 0x400 + 4 * notTaken.length);
  });

  test("BNE / BLTZ / BGEZ / BGEZAL link-always", () => {
    const start = 0x500;
    const prog = [
      LUI(1, 0xffff), ORI(1, 1, 0xffff), // r1 = -1
      BNE(1, 0, 1), NOP, // taken (r1 != 0): skips next
      ADDIU(2, 0, 0x111), // skipped by BNE
      BLTZ(1, 1), NOP, // taken (negative)
      ADDIU(3, 0, 0x222), // skipped
      BGEZ(2, 1), NOP, // taken (r2 = 0x111 ≥ 0)
      ADDIU(4, 0, 0x333), // skipped
      BGEZAL(0, 1), NOP, // taken, r31 = pc+8 always
      SW(2, 0, 0x700), // target chain lands here
    ];
    const { cpuA } = expectParity(prog, start, start + 4 * prog.length);
    expect(cpuA.r[2]).toBe(0x111);
    // BGEZAL is at 0x500 + 4*11 = 0x52c; link = instr addr + 8 = 0x534
    expect(cpuA.r[31]! >>> 0).toBe(0x534);
  });

  test("JAL link + JR $ra return across blocks", () => {
    const start = 0x800, leaf = 0x900;
    const prog = [
      JAL(leaf, start), ADDIU(4, 0, 0x444), // delay slot runs before leaf
      SW(4, 0, 0x9000), // return lands here (pc = start+12 after JR $ra)
    ];
    const end = start + 4 * prog.length; // JR $ra returns to start+12 = end
    const leafCode = [
      ADDIU(5, 0, 0x555),
      JR(31), ADDIU(6, 0, 0x666), // delay slot executes on the way back
    ];
    const { cpuA, cpuB } = runBothSpecial(prog, leafCode, start, leaf, end);
    for (let i = 0; i < 32; i++) {
      if (cpuB.r[i] !== cpuA.r[i]) {
        console.log("JAL r" + i + ": A=0x" + (cpuA.r[i]! >>> 0).toString(16) + " B=0x" + (cpuB.r[i]! >>> 0).toString(16) +
          " pcA=0x" + (cpuA.pc >>> 0).toString(16) + " pcB=0x" + (cpuB.pc >>> 0).toString(16));
      }
      expect(cpuB.r[i]).toBe(cpuA.r[i]);
    }
    expect(cpuB.pc).toBe(cpuA.pc);
    expect(cpuA.r[31]! >>> 0).toBe(start + 8); // JAL link = pc+8
    expect(cpuA.r[5]).toBe(0x555);
    expect(cpuA.r[6]).toBe(0x666);
    expect(cpuA.r[4]).toBe(0x444);
  });
});

/** runBoth variant with a second code page for the JAL leaf. */
function runBothSpecial(prog: number[], leaf: number[], start: number, leafAddr: number, end: number) {
  const mk = () => {
    const mem = new Memory();
    const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts);
    cpu.reset(start);
    for (let i = 0; i < prog.length; i++) mem.store32(start + 4 * i, prog[i]);
    for (let i = 0; i < leaf.length; i++) mem.store32(leafAddr + 4 * i, leaf[i]);
    return { mem, cpu };
  };
  const a = mk();
  const b = mk();
  const dyn = new Dynarec();
  const hooks = {
    read32: (va: number) => b.mem.load32(va) | 0,
    write32: (va: number, v: number) => void b.mem.store32(va, v),
    exit: () => {},
    memory: dyn.memory,
  };
  let guard = 0;
  while (a.cpu.pc !== end && guard++ < 1000) a.cpu.step();
  guard = 0;
  while (b.cpu.pc !== end && guard++ < 100) dyn.run(b.cpu.pc, (x) => b.mem.load32(x) | 0, hooks, b.cpu);
  return { cpuA: a.cpu, cpuB: b.cpu, dyn };
}

describe("cache invalidation", () => {
  test("invalidate(start,end) forces re-translate with new code", () => {
    const dyn = new Dynarec();
    const mem = new Memory();
    const cpu: CpuState = { r: new Int32Array(32), pc: 0, nextPc: 4, hi: 0, lo: 0, cycles: 0 };
    const hooks = {
      read32: (va: number) => mem.load32(va) | 0,
      write32: (va: number, v: number) => void mem.store32(va, v),
      exit: () => {},
      memory: dyn.memory,
    };
    mem.store32(0, LUI(1, 0x0aaa));
    mem.store32(4, SW(1, 0, 0x100)); // v1 block: LUI+SW
    dyn.run(0, (a) => mem.load32(a) | 0, hooks, cpu);
    expect(dyn.compiles).toBe(1);
    expect(cpu.r[1]! >>> 0).toBe(0x0aaa_0000);

    // self-modifying: overwrite the LUI, invalidate the affected range
    mem.store32(0, LUI(1, 0x0bbb));
    dyn.invalidate(0, 4);
    expect(dyn.size).toBe(0);
    cpu.pc = 0; cpu.nextPc = 4; cpu.cycles = 0;
    dyn.run(0, (a) => mem.load32(a) | 0, hooks, cpu);
    expect(dyn.compiles).toBe(2);
    expect(cpu.r[1]! >>> 0).toBe(0x0bbb_0000);

    // flush clears everything
    dyn.flush();
    expect(dyn.size).toBe(0);
  });

  test("non-overlapping invalidate keeps the block cached", () => {
    const dyn = new Dynarec();
    const mem = new Memory();
    mem.store32(0, SW(0, 0, 0));
    const hooks = {
      read32: (va: number) => mem.load32(va) | 0,
      write32: (va: number, v: number) => void mem.store32(va, v),
      exit: () => {},
      memory: dyn.memory,
    };
    const cpu: CpuState = { r: new Int32Array(32), pc: 0, nextPc: 4, hi: 0, lo: 0, cycles: 0 };
    dyn.run(0, (a) => mem.load32(a) | 0, hooks, cpu);
    expect(dyn.compiles).toBe(1);
    dyn.invalidate(0x1000, 0x1100); // far away
    expect(dyn.size).toBe(1);
    dyn.invalidate(4, 8); // inside the 4-byte block (single SW)
    expect(dyn.size).toBe(0);
  });
});

describe("1000-block benchmark", () => {
  test("compiles and runs 1000 distinct blocks, bus values correct", () => {
    const dyn = new Dynarec();
    const bus = new Map<number, number>();
    const hooks = {
      read32: (va: number) => bus.get(va >>> 0) ?? 0,
      write32: (va: number, v: number) => void bus.set(va >>> 0, v | 0),
      exit: () => {},
      memory: dyn.memory,
    };
    const cpu: CpuState = { r: new Int32Array(32), pc: 0, nextPc: 4, hi: 0, lo: 0, cycles: 0 };
    const words: number[] = [];
    const N = 1000;
    words.push(LUI(2, 0x4000)); // word 0: r2 = 0x4000_0000 store base
    for (let i = 0; i < N; i++) {
      // Block i = words 1+3i .. 3+3i, ending at its SW (store boundary).
      words.push(LUI(1, i & 0xffff)); // r1 = i << 16
      words.push(ADDIU(1, 1, i & 0xffff)); // r1 |= i
      words.push(SW(1, 2, (4 * (1 + 3 * i)) & 0xffff)); // store at bus 0x40000000 + block pc
    }
    const t0 = performance.now();
    dyn.run(0, (a) => words[a >> 2]! | 0, hooks, cpu); // word 0: base LUI r2
    for (let i = 0; i < N; i++) {
      cpu.pc = 4 * (1 + 3 * i);
      cpu.nextPc = cpu.pc + 4;
      dyn.run(cpu.pc, (a) => words[a >> 2]! | 0, hooks, cpu);
    }
    const ms = performance.now() - t0;
    expect(dyn.compiles).toBe(N + 1); // +1: the base-LUI word-0 block
    expect(dyn.size).toBe(N + 1);
    // Cycle accounting (per-block increment model) is a Phase-4 follow-up;
    // gate: cycles accumulate ≥ 1 per executed block.
    expect(cpu.cycles).toBeGreaterThanOrEqual(N);
    // Block i stores at bus address 0x40000000 + (4 + 12i) — its own pc:
    const blockStoreAddr = (i: number) => 0x4000_0000 + 4 * (1 + 3 * i);
    const blockVal = (i: number) => (((i << 16) | i) >>> 0);
    expect(bus.get(blockStoreAddr(0))! >>> 0).toBe(blockVal(0)); // 0
    expect(bus.get(blockStoreAddr(500))! >>> 0).toBe(blockVal(500));
    expect(bus.get(blockStoreAddr(999))! >>> 0).toBe(blockVal(999));
    console.log(`dynarec: ${N} blocks compiled+executed in ${ms.toFixed(1)}ms`);
  });
});

describe("determinism", () => {
  test("same program, two dynarec runs → identical state", () => {
    const run = () => {
      const dyn = new Dynarec();
      const mem = new Memory();
      const cpu: CpuState = { r: new Int32Array(32), pc: 0, nextPc: 4, hi: 0, lo: 0, cycles: 0 };
      const hooks = {
        read32: (va: number) => mem.load32(va) | 0,
        write32: (va: number, v: number) => void mem.store32(va, v),
        exit: () => {},
        memory: dyn.memory,
      };
      const prog = [LUI(1, 0x1234), ORI(1, 1, 0x8fff), ADDIU(1, 1, -1), SW(1, 0, 0x200)];
      for (let i = 0; i < prog.length; i++) mem.store32(4 * i, prog[i]);
      let guard = 0;
      while (cpu.pc !== 16 && guard++ < 100) dyn.run(cpu.pc, (a) => mem.load32(a) | 0, hooks, cpu);
      return [...cpu.r].join(",");
    };
    expect(run()).toBe(run());
  });
});

describe("Cpu.run dynarec integration", () => {
  test("opt-in blocks preserve registers, delay state, PC and counts", () => {
    const make = () => {
      const mem = new Memory();
      const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts);
      const prog = [ADDIU(2, 0, 3), LW(1, 0, 0x1000), ADDIU(1, 1, 1), SW(1, 0, 0x1004)];
      prog.forEach((word, i) => mem.store32(4 * i, word));
      mem.store32(0x1000, 7);
      cpu.reset(0);
      return { cpu, mem };
    };
    const a = make(), b = make();
    expect(b.cpu.dynarecEnabled).toBe(false);
    expect(a.cpu.run(4)).toBe(true);
    b.cpu.setDynarecEnabled(true);
    expect(b.cpu.run(4)).toBe(true);
    expect([...b.cpu.r]).toEqual([...a.cpu.r]);
    expect([...b.cpu.cp0]).toEqual([...a.cpu.cp0]);
    expect(b.cpu.loadDelay).toEqual(a.cpu.loadDelay);
    expect(b.cpu.inBranchDelay).toBe(a.cpu.inBranchDelay);
    expect(b.cpu.pc).toBe(a.cpu.pc);
    expect(b.cpu.nextPc).toBe(a.cpu.nextPc);
    expect(b.cpu.cycles).toBe(4);
    expect(b.mem.load32(0x1004)).toBe(a.mem.load32(0x1004));
  });

  test("unsupported GTE falls back without replaying earlier effects", () => {
    const mem = new Memory();
    let gteCalls = 0;
    const gte = { execute: () => { gteCalls++; }, mfc2: () => 0, mtc2: () => {} };
    const cpu = new Cpu(mem, new Rcnt(), gte, noPorts);
    const prog = [ADDIU(1, 0, 1), ((0x12 << 26) | (1 << 25) | 1) >>> 0, SW(1, 0, 0x1000)];
    prog.forEach((word, i) => mem.store32(4 * i, word));
    cpu.reset(0);
    cpu.setDynarecEnabled(true);
    expect(cpu.run(3)).toBe(true);
    expect(gteCalls).toBe(1);
    expect(cpu.r[1]).toBe(1);
    expect(cpu.cycles).toBe(3);
    expect(cpu.pc).toBe(12);
    expect(mem.load32(0x1000)).toBe(1);
  });

  test("self-modifying SW invalidates an already cached target", () => {
    const mem = new Memory();
    const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts);
    mem.store32(0, SW(1, 0, 0x100));
    mem.store32(0x100, LUI(2, 0x111));
    mem.store32(0x104, SW(2, 0, 0x1000));
    cpu.reset(0x100);
    cpu.setDynarecEnabled(true);
    expect(cpu.run(2)).toBe(true);
    expect(cpu.r[2]).toBe(0x0111_0000);

    cpu.r[1] = ORI(2, 0, 0x222) | 0;
    cpu.pc = 0; cpu.nextPc = 4;
    expect(cpu.run(1)).toBe(true);
    expect(mem.load32(0x100)).toBe(ORI(2, 0, 0x222));
    cpu.pc = 0x100; cpu.nextPc = 0x104;
    expect(cpu.run(2)).toBe(true);
    expect(cpu.r[2]).toBe(0x222);
    expect(mem.load32(0x1000)).toBe(0x222);
  });

  test("block loads and stores use existing MMIO hooks", () => {
    const mem = new Memory();
    let reads = 0;
    const writes: [number, number, number][] = [];
    const cpu = new Cpu(mem, new Rcnt(), gteStub, {
      read32: (va) => { expect(va).toBe(0x1f80_1100); reads++; return 0x123; },
      write32: (va, v, width) => { writes.push([va, v, width]); return true; },
    });
    const prog = [LW(1, 3, 0x1100), ADDIU(2, 1, 1), SW(2, 3, 0x1104)];
    prog.forEach((word, i) => mem.store32(4 * i, word));
    cpu.reset(0);
    cpu.r[3] = 0x1f80_0000;
    cpu.setDynarecEnabled(true);
    expect(cpu.run(3)).toBe(true);
    expect(reads).toBe(1);
    expect(writes).toEqual([[0x1f80_1104, 0x124, 32]]);
    expect(cpu.r[2]).toBe(0x124);
  });

  test("HLE syscall executes once through interpreter fallback", () => {
    const mem = new Memory();
    const calls: [number, number][] = [];
    const cpu = new Cpu(mem, new Rcnt(), gteStub, noPorts, (table, fn) => {
      calls.push([table, fn]);
      return 0x99;
    });
    mem.store32(0xa0, R(0x0c));
    cpu.reset(0x8000_00a0);
    cpu.r[9] = 0x42;
    cpu.r[31] = 0x200;
    cpu.setDynarecEnabled(true);
    expect(cpu.run(1)).toBe(true);
    expect(calls).toEqual([[0xa0, 0x42]]);
    expect(cpu.r[2]).toBe(0x99);
    expect(cpu.pc).toBe(0x200);
    expect(cpu.cycles).toBe(1);
  });

  test("Machine state roundtrip retains a block-ending load delay", () => {
    const machine = new Machine();
    machine.mem.store32(0x100, BEQ(0, 0, 1));
    machine.mem.store32(0x104, LW(1, 0, 0x1000));
    machine.mem.store32(0x108, ADDIU(2, 1, 0));
    machine.mem.store32(0x1000, 0x55);
    machine.cpu.reset(0x100);
    machine.setDynarecEnabled(true);
    expect(machine.cpu.run(2)).toBe(true);
    expect(machine.cpu.r[1]).toBe(0);
    expect(machine.cpu.loadDelay).toEqual({ slot: 1, reg: 1, value: 0x55 });
    expect(machine.cpu.inBranchDelay).toBe(true);
    const saved = machine.saveState();
    expect(machine.cpu.run(1)).toBe(true);
    expect(machine.cpu.r[2]).toBe(0x55);
    machine.loadState(saved);
    expect(machine.cpu.loadDelay).toEqual({ slot: 1, reg: 1, value: 0x55 });
    expect(machine.saveState()).toEqual(saved);
    expect(machine.cpu.run(1)).toBe(true);
    expect(machine.cpu.r[2]).toBe(0x55);
  });
});
