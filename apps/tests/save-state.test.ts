import { describe, expect, test } from "bun:test";
import { Machine } from "../src/core/machine";
import type { SpuAudioSink } from "../src/core/spu-audio";

function kernelCall(
  m: Machine, table: number, fn: number,
  arg0 = 0, arg1 = 0, arg2 = 0, arg3 = 0,
): number {
  m.cpu.reset(table);
  m.cpu.r[9] = fn;
  m.cpu.r[4] = arg0; m.cpu.r[5] = arg1; m.cpu.r[6] = arg2; m.cpu.r[7] = arg3;
  m.cpu.r[31] = 0x200;
  m.cpu.step();
  return m.cpu.r[2]!;
}

interface Fixture {
  machine: Machine;
  sectorRequests: number[];
  audioFrames: () => number;
}

function fixture(): Fixture {
  const m = new Machine();
  m.installHleVectors();
  const sectorRequests: number[] = [];
  m.setSectorProvider((lba) => {
    sectorRequests.push(lba);
    const sector = new Uint8Array(2352);
    for (let i = 0; i < sector.length; i++) sector[i] = (lba * 37 + i * 13) & 0xff;
    return sector;
  });

  // Main program: increment a RAM counter forever.
  const program = [0x2508_0001, 0xaca8_0000, 0x0800_c000, 0];
  program.forEach((word, index) => m.mem.store32(0x30000 + index * 4, word));
  // CDROM completion callback, entered through the normal HLE event queue.
  const callback = [0x2408_0001, 0xac28_0000, 0x03e0_0008, 0];
  callback.forEach((word, index) => m.mem.store32(0x10000 + index * 4, word));
  const event = kernelCall(m, 0xb0, 0x08, 0xf000_0003, 0x10, 0x1000, 0x8001_0000);
  kernelCall(m, 0xb0, 0x0c, event);
  kernelCall(m, 0xa0, 0x39, 0x8004_0000);
  kernelCall(m, 0xa0, 0x33, 0x123);
  kernelCall(m, 0xb0, 0x00, 0x45);

  // A display setup plus an incomplete GP0 fill exercises parser restoration.
  m.gpu.writeGP1(0x0800_0001);
  m.gpu.writeGP1(0x0500_0000);
  m.gpu.writeGP0(0x0200_a5a5);
  m.gpu.writeGP0((8 << 16) | 12);
  m.gpu.vram[0] = 0x1234;

  // Start a read and consume only part of its buffered sector.
  for (const param of [0, 0, 2]) m.cdrom.write(2, param);
  m.cdrom.write(1, 0x02);
  m.cdrom.ack(7);
  m.cdrom.write(1, 0x06);
  m.cdrom.ack(7);
  m.cdrom.pump();
  m.cdrom.exec();
  m.cdrom.ack(7);
  m.cdrom.write(0, 0);
  m.cdrom.write(3, 0x80);
  for (let i = 0; i < 4; i++) m.cdrom.readData32();

  // Active ADPCM/envelope state, a partial SIO packet, timers, and pending DMA.
  m.spu.ram[0] = 0x0c; m.spu.ram[1] = 0; m.spu.ram[2] = 0x77;
  m.spu.regs[2] = 0x1000; m.spu.regs[3] = 0; m.spu.regs[4] = 0x000f;
  m.spu.regs[0x180] = 0x3fff; m.spu.regs[0x182] = 0x3fff;
  m.spu.write(0x01aa, 0xc000);
  m.spu.keyOn(1);
  m.pads.pad1 = 0xff7f;
  m.joypad.write(0x1f80_104a, 3);
  m.joypad.write(0x1f80_1040, 1);
  m.joypad.write(0x1f80_1040, 0x42);
  m.rcnt.regs[0] = 100; m.rcnt.regs[1] = 0x100; m.rcnt.regs[2] = 110;
  m.dma.regs[18] = 0x700; m.dma.regs[19] = 4;
  m.dma.dpcr = 0x0800_0000; m.dma.request(6);
  m.mdec.write((2 << 29) | 1);
  for (let i = 0; i < 4; i++) m.mdec.pushWord(0x0102_0304 + i);

  m.cpu.reset(0x8003_0000);
  m.cpu.r[1] = 0x8000_9000 | 0; m.cpu.r[5] = 0x8000_8000 | 0; m.cpu.r[8] = 7;
  m.cpu.cp0[12] = 0x401;
  m.irqMask = 0;
  m["vblankAcc"] = 562_950;

  let audioFrames = 0;
  const sink = {
    push(left: Float32Array, right: Float32Array) {
      audioFrames += Math.min(left.length, right.length);
      return left.length;
    },
  } as SpuAudioSink;
  m.setAudioSink(sink);
  m.runSlice(1536);
  // Save with future work still pending, not with the warm-up's completed work.
  m.rcnt.regs[0] = 100; m.rcnt.regs[1] = 0x100;
  m.dma.request(6);
  m.irqStatus = 0;
  m["vblankAcc"] = 562_950;
  return { machine: m, sectorRequests, audioFrames: () => audioFrames };
}

function hash(bytes: Uint8Array): number {
  let result = 2166136261;
  for (const byte of bytes) result = Math.imul(result ^ byte, 16777619);
  return result >>> 0;
}

function continueRun(f: Fixture): unknown[] {
  const m = f.machine;
  const requestStart = f.sectorRequests.length;
  const trace: unknown[] = [];
  for (let step = 0; step < 8; step++) {
    if (step === 0) m.gpu.writeGP0((4 << 16) | 5); // complete the saved GP0 fill
    m.cdrom.ack(7);
    m.cdrom.write(0, 0); m.cdrom.write(3, 0x80);
    for (let i = 0; i < 128; i++) m.cdrom.readData32();
    m.joypad.write(0x1f80_1040, 0);
    m.runSlice(768);
    m.gpu.composeFrame();
    const display = m.gpu.composeDisplayFrame();
    trace.push([
      m.cpu.pc, m.cpu.cycles, m.cpu.r[8], m.mem.load32(0x8000), m.mem.load32(0x9000),
      m.irqStatus, Array.from(m.rcnt.regs), Array.from(m.cdrom.regs),
      hash(m.gpu.screen), hash(display.rgba), m.dma.dicr, m.mdec.regs,
    ]);
  }
  trace.push(f.sectorRequests.slice(requestStart));
  return trace;
}

describe("complete versioned machine save states", () => {
  test("save/continue/save/load/continue preserves frames, traces, and drive position", () => {
    const original = fixture();
    const saved = original.machine.saveState();
    expect(original.machine.saveState()).toEqual(saved);

    const firstTrace = continueRun(original);
    const continued = original.machine.saveState();
    original.machine.loadState(saved);
    const replayTrace = continueRun(original);
    expect(replayTrace).toEqual(firstTrace);
    expect(original.machine.saveState()).toEqual(continued);
    const framesBefore = original.audioFrames();
    original.machine.runSlice(768);
    expect(original.audioFrames()).toBe(framesBefore + 1); // host sink survived load

    const reloaded = fixture();
    reloaded.machine.loadState(saved);
    expect(reloaded.machine.saveState()).toEqual(saved);
    expect(continueRun(reloaded)).toEqual(firstTrace);
    expect(reloaded.machine.saveState()).toEqual(continued);
  });

  test("malformed, truncated, corrupt, and future-version inputs are atomic rejections", () => {
    const f = fixture();
    const before = f.machine.saveState();
    const future = before.slice();
    new DataView(future.buffer).setUint32(4, 2, true);
    const corrupt = before.slice();
    corrupt[corrupt.length - 1] ^= 0x80;
    const trailing = new Uint8Array(before.length + 1);
    trailing.set(before);
    const badMagic = before.slice();
    badMagic[0] ^= 0xff;
    const invalid = [
      new Uint8Array(0), before.slice(0, 15), before.slice(0, before.length - 1),
      future, corrupt, trailing, badMagic,
    ];
    for (const bytes of invalid) {
      expect(() => f.machine.loadState(bytes)).toThrow();
      expect(f.machine.saveState()).toEqual(before);
    }
  });
});
