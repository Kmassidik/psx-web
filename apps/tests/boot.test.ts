import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";
import { buildHelloExe, HELLO_PC } from "../src/core/hello-exe";
import { parsePsExe } from "../src/core/loader/psexe";
import type { SpuAudioSink } from "../src/core/spu-audio";

describe("Phase-1 boot: hello EXE end-to-end (loader → CPU → bus → GPU)", () => {
  test("EXE boots, fills VRAM green via GP0, spins in loop", () => {
    const { bytes } = buildHelloExe(0x03e0); // BGR555 green
    const exe = parsePsExe(bytes);
    const m = new Machine();
    m.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);

    // run: ~20 instructions of setup + the fill DMA-less path + loop entry
    let ok = true;
    for (let i = 0; i < 100 && ok; i++) ok = m.runSlice(1000);

    // PC parked in the self-loop at 0x80010028 (physical 0x10028): the j
    // instruction sits at code index 9, its delay-slot nop at index 10.
    expect(m.cpu.pc & 0x1f_ffff).toBe((HELLO_PC + 10 * 4) & 0x1f_ffff);
    // VRAM row 0: green 0x03E0 across the fill area
    expect(m.gpu.vram[0]).toBe(0x03e0);
    expect(m.gpu.vram[1023]).toBe(0x03e0);
    expect(m.gpu.vram[512 * 1024 - 1]).toBe(0x03e0);
    // compose produces opaque green pixels in the RGBA output
    m.gpu.composeFrame();
    expect(m.gpu.screen[0]).toBe(0); // R
    expect(m.gpu.screen[1]).toBe(255); // G: 5→8 bit expand (31<<3|31>>2 = 255)
    expect(m.gpu.screen[3]).toBe(255); // A
  });

  test("different color: red fill (0x001F)", () => {
    const { bytes } = buildHelloExe(0x001f);
    const exe = parsePsExe(bytes);
    const m = new Machine();
    m.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
    for (let i = 0; i < 100; i++) m.runSlice(1000);
    expect(m.gpu.vram[0]).toBe(0x001f);
    m.gpu.composeFrame();
    expect(m.gpu.screen[0]).toBeGreaterThan(240); // R near max
    expect(m.gpu.screen[1]).toBeLessThan(16); // G near 0
  });

  test("determinism: two boots produce identical VRAM hash", () => {
    const boot = () => {
      const { bytes } = buildHelloExe(0x7c1f);
      const exe = parsePsExe(bytes);
      const m = new Machine();
      m.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
      for (let i = 0; i < 100; i++) m.runSlice(1000);
      m.gpu.composeFrame();
      return m.gpu.hashFrame();
    };
    expect(boot()).toBe(boot());
  });
});

describe("GP0 image upload", () => {
  test("commits the final packed word and accepts the next command", () => {
    const m = new Machine();
    m.gpu.writeGP0(0xa000_0000);
    m.gpu.writeGP0(0);
    m.gpu.writeGP0((1 << 16) | 2); // 2×1 pixels = one packed word
    m.gpu.writeGP0(0x7fff_0000);
    expect(m.gpu.vram[0]).toBe(0);
    expect(m.gpu.vram[1]).toBe(0x7fff);
    m.gpu.writeGP0(0x0200_001f);
    m.gpu.writeGP0(2);
    m.gpu.writeGP0((1 << 16) | 1);
    expect(m.gpu.vram[2]).toBe(0x001f);
  });
});

describe("GP0 rectangles", () => {
  test("flat variable-size rectangle reaches VRAM", () => {
    const m = new Machine();
    m.gpu.writeGP0(0x6000_00ff);
    m.gpu.writeGP0(2);
    m.gpu.writeGP0((2 << 16) | 2);
    expect(m.gpu.vram[2]).toBe(0x001f);
    expect(m.gpu.vram[3]).toBe(0x001f);
    expect(m.gpu.vram[1024 + 2]).toBe(0x001f);
    expect(m.gpu.vram[1024 + 3]).toBe(0x001f);
  });
});

describe("GPU status", () => {
  test("synchronous GPU reports command, VRAM-read, and DMA readiness", () => {
    const m = new Machine();
    expect(m.gpu.readGPUSTAT() & 0x1c00_0000).toBe(0x1c00_0000);
  });

  test("LW from GP1 reaches GPUSTAT through the bus", () => {
    const m = new Machine();
    m.cpu.reset(0);
    m.cpu.r[1] = 0x1f80_1814;
    m.mem.store32(0, 0x8c22_0000); // LW v0, 0(at)
    m.cpu.step();
    m.cpu.step();
    expect(m.cpu.r[2]! & 0x1c00_0000).toBe(0x1c00_0000);
  });
});

describe("DMA bus mapping", () => {
  test("channel registers use 0x10-byte spacing", () => {
    const m = new Machine();
    m.portWrite(0x1f80_10c0, 0x1234_5678, 32); // channel 4 MADR
    expect(m.dma.regs[4 * 3]).toBe(0x1234_5678);
    expect(m.portRead(0x1f80_10c0)).toBe(0x1234_5678);
  });
});

describe("MMIO access widths", () => {
  test("SH reaches SPU ATTR and enables its IRQ bit", () => {
    const m = new Machine();
    m.cpu.reset(0);
    m.cpu.r[1] = 0x1f80_1daa;
    m.cpu.r[2] = 0x40;
    m.mem.store32(0, ((0x29 << 26) | (1 << 21) | (2 << 16)) >>> 0); // SH v0, 0(at)
    m.cpu.step();
    expect(m.spu.read(0x1aa) & 0x40).toBe(0x40);
  });
});

describe("SPU audio attachment", () => {
  test("mixes and pushes floor(cycles / 768) frames to the attached sink", () => {
    const m = new Machine();
    let frames = 0;
    const sink = {
      push(left: Float32Array, right: Float32Array) {
        expect(left.length).toBe(right.length);
        frames += left.length;
        return left.length;
      },
    } as SpuAudioSink;
    m.setAudioSink(sink);
    m.runSlice(1536);
    expect(frames).toBe(2);
  });
});

describe("Hardware interrupt delivery", () => {
  test("I_STAT acknowledges selected IRQs by clearing zero bits", () => {
    const m = new Machine();
    m.irqStatus = 0x000f;
    m["portWrite"](0x1f801070, 0xfffffffe, 16);
    expect(m.irqStatus).toBe(0x000e);
  });
  test("masked pending IRQ enters the handler and RFE returns to EPC", () => {
    const m = new Machine();
    m.installHleVectors();
    m.cpu.reset(0x8001_0000);
    m.cpu.cp0[12] = 0x401;
    m.irqStatus = 1 << 3;
    m.irqMask = 1 << 3;
    m.runSlice(4);
    expect(m.cpu.cp0[13]! & 0x400).toBe(0x400);
    expect(m.cpu.pc).toBe(0x8001_0000 | 0);
  });

  test("VBlank handler preserves CPU state but keeps memory side effects", () => {
    const m = new Machine();
    m.installHleVectors();
    m.mem.store32(0x10000, 0x2408_0001); // ADDIU t0, zero, 1
    m.mem.store32(0x10004, 0xac28_0000); // SW t0, 0(t1)
    m.mem.store32(0x10008, 0x03e0_0008); // JR ra
    m.mem.store32(0x1000c, 0);
    m.mem.store32(0x408, 0x8001_0000);
    m.cpu.reset(0xc0);
    m.cpu.r[9] = 2;
    m.cpu.r[4] = 1;
    m.cpu.r[5] = 0x400;
    m.cpu.r[31] = 0x200;
    m.cpu.step();
    m.cpu.reset(0x8003_0000);
    m.cpu.r[1] = 0x400;
    m.cpu.r[31] = 0x8001_2345;
    m.cpu.run(10);
    const expectedPc = m.cpu.pc;
    m["runVblankHandler"]();
    expect(m.mem.load32(0x400)).toBe(1);
    expect(m.cpu.pc).toBe(expectedPc);
    expect(m.cpu.r[31]).toBe(0x8001_2345 | 0);
  });

  test("wild low-address handler aborts without executing garbage or losing interrupted state", () => {
    const m = new Machine();
    m.mem.store32(0x10000, 0x0000_0008); // JR zero
    m.mem.store32(0x10004, 0);
    m.mem.store32(0, 0xac28_0000); // SW t0, 0(at): must not execute
    m.cpu.reset(0x8003_0000);
    m.cpu.r[1] = 0x400;
    m.cpu.r[8] = 1;
    m.cpu.r[31] = 0x8001_2345;
    const registers = m.cpu.r.slice();
    m["runHandler"](0x8001_0000);
    expect(m.mem.load32(0x400)).toBe(0);
    expect(m.cpu.pc >>> 0).toBe(0x8003_0000);
    expect(m.cpu.r).toEqual(registers);
  });

  test("handler timer waits advance RCNT and complete beyond 10,000 instructions", () => {
    for (const dynarec of [false, true]) {
    const m = new Machine();
    m.setDynarecEnabled(dynarec);
    const code = [
      0x3c01_1f80, 0x3421_1110, // at = RCNT1_VALUE
      0x8c28_0000, 0, // t0 = initial counter
      0x250a_176f, // t2 = t0 + 5999
      0x8c29_0000, 0, // loop: t1 = counter
      0x012a_082a, // at = t1 < t2
      0x1020_0003, 0, // beq at,zero,complete (+ delay)
      0x2800_4005, 0, // j loop
      0xacea_0000, // complete: SW t2, 0(a3)
      0x03e0_0008, 0,
    ];
    code.forEach((word, index) => m.mem.store32(0x10000 + index * 4, word));
    m.cpu.reset(0x8003_0000);
    m.cpu.r[7] = 0x400;
    m["runHandler"](0x8001_0000);
    expect(m.mem.load32(0x400)).toBeGreaterThanOrEqual(5999);
    expect(m.mem.load32(0x400)).toBeLessThan(6064);
    expect(m.cpu.pc >>> 0).toBe(0x8003_0000);
    }
  });

  test("custom exception hook preserves the saved continuation stack pointer", () => {
    const m = new Machine();
    m.installHleVectors();
    m.mem.store32(0x4000, 0x8001_0000);
    m.mem.store32(0x4004, 0x807f_fef0);
    m.mem.store32(0x4008, 0x807f_0000);
    m.cpu.reset(0xb0);
    m.cpu.r[9] = 0x19;
    m.cpu.r[4] = 0x4000;
    m.cpu.r[31] = 0x200;
    m.cpu.step();
    const original = m.cpu.step.bind(m.cpu);
    let observed = 0;
    m.cpu.step = () => { observed = m.cpu.r[29]! >>> 0; return original(); };
    m["runHandler"](0x8001_0000, "exception");
    expect(observed).toBe(0x807f_fef0);
  });

  test("custom exception hook runs after default service with CPU state preserved", () => {
    const m = new Machine();
    m.installHleVectors();
    m.mem.store32(0x10000, 0x2408_0001);
    m.mem.store32(0x10004, 0xac28_0000); // SW t0, 0(t1)
    m.mem.store32(0x10008, 0x03e0_0008);
    m.mem.store32(0x1000c, 0);
    m.mem.store32(0x400, 0x8001_0000); // SaveState r31/pc
    m.cpu.reset(0xb0);
    m.cpu.r[9] = 0x19;
    m.cpu.r[4] = 0x400;
    m.cpu.r[31] = 0x200;
    m.cpu.step();
    m.cpu.reset(0x8003_0000);
    m.cpu.r[1] = 0x500;
    m.cpu.r[31] = 0x8001_2345;
    m.cpu.cp0[12] = 0x401;
    m.irqStatus = m.irqMask = 1 << 3;
    m.runSlice(4);
    expect(m.mem.load32(0x500)).toBe(1);
    expect(m.cpu.pc >>> 0).toBe(0x8003_0000);
    expect(m.cpu.r[31]).toBe(0x8001_2345 | 0);
  });

  test("runSlice advances timer zero and raises IRQ4 at target", () => {
    const m = new Machine();
    let line = -1;
    m.rcnt.irqFire = (value) => { line = value; };
    m.rcnt.regs[0] = 9;
    m.rcnt.regs[1] = 0x10;
    m.rcnt.regs[2] = 10;
    m.runSlice(1);
    expect(line).toBe(4);
    expect(m.rcnt.regs[0]).toBe(10);
  });

  test("CDROM auto-ack is disabled by default", () => {
    const m = new Machine();
    m.irqStatus = 1 << 2;
    m.irqMask = 1 << 2;
    m.cdrom.regs[5] = 3;
    m.runSlice(1);
    expect(m.irqStatus & (1 << 2)).toBe(1 << 2);
    expect(m.cdrom.regs[5]).toBe(3);
  });
});

describe("Machine snapshot → restore equivalence (zsave/zload spec)", () => {
  test("snapshot → restore → continue == uninterrupted run", () => {
    const { bytes } = buildHelloExe(0x7c1f);
    const exe = parsePsExe(bytes);
    const a = new Machine();
    a.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
    for (let i = 0; i < 50; i++) a.runSlice(1000);
    const snap = a.snapshot();
    for (let i = 0; i < 50; i++) a.runSlice(1000); // continue
    const b = new Machine();
    b.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
    for (let i = 0; i < 50; i++) b.runSlice(1000);
    b.restore(snap);
    for (let i = 0; i < 50; i++) b.runSlice(1000);
    expect(b.cpu.pc).toBe(a.cpu.pc);
    expect(b.cpu.cycles).toBe(a.cpu.cycles);
    expect(Array.from(b.cpu.r)).toEqual(Array.from(a.cpu.r));
    expect(b.gpu.vram[0]).toBe(a.gpu.vram[0]);
    expect(b.gpu.hashFrame()).toBe(a.gpu.hashFrame());
  });
});
