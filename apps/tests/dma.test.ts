/**
 * DMA controller tests: block loopback, linked-list walk, OTC table,
 * DPCR gating, DICR status/IRQ, CHCR enable bits. Seeded + boundary cases.
 */
import { describe, test, expect } from "bun:test";
import { Dma, type DmaBus } from "../src/core/dma";

/** 2 MiB RAM with word accessors, wired as a DmaBus. */
class TestBus implements DmaBus {
  readonly ram = new Uint8Array(0x20_0000);
  readonly vram = new Uint16Array(0x10_0000);
  readonly writes: number[] = [];
  mdecInCalls = 0;
  mdecOutQueue: number[] = [];
  cdromQueue: number[] = [];

  readVram(addr: number): number { return this.vram[(addr >>> 1) & 0xfffff]!; }
  writeVram(addr: number, v: number): void { this.vram[(addr >>> 1) & 0xfffff] = v & 0xffff; }
  readRam(a: number): number {
    const p = a & 0x1f_fffc;
    return (this.ram[p]! | (this.ram[p + 1]! << 8) | (this.ram[p + 2]! << 16) | (this.ram[p + 3]! << 24)) >>> 0;
  }
  writeRam(a: number, v: number): void {
    const p = a & 0x1f_fffc;
    this.ram[p] = v & 0xff; this.ram[p + 1] = (v >>> 8) & 0xff;
    this.ram[p + 2] = (v >>> 16) & 0xff; this.ram[p + 3] = (v >>> 24) & 0xff;
  }
  mdecIn(w: number): void { this.mdecInCalls++; this.writes.push(w); }
  mdecOut(): number { return this.mdecOutQueue.shift() ?? 0; }
  cdromRead(): number { return this.cdromQueue.shift() ?? 0; }
  gpuWrite(w: number): void { this.writes.push(w); }
}

/** Seed word w at RAM word offset idx. */
function seed(bus: TestBus, idx: number, w: number): void {
  bus.writeRam(idx * 4, w);
}

/** ch3 CDROM block read: DR from RAM, sync 0 burst, N words. */
function setupBlockRead(d: Dma, bus: TestBus, addr: number, count: number, ch = 3): void {
  d.regs[ch * 3] = addr;
  d.regs[ch * 3 + 1] = count;
  d.regs[ch * 3 + 2] = 0x0200_0000 | 0x1100_0000; // to RAM, start, burst
}

describe("DMA block transfers (RAM loopback)", () => {
  test("ch3 CDROM burst read: N seeded words land at MADR", () => {
    const bus = new TestBus();
    const d = new Dma();
    for (let i = 0; i < 4; i++) bus.cdromQueue.push(0xaa00 + i);
    setupBlockRead(d, bus, 0x1000, 4);
    d.request(3);
    d.dpcr = 0x4000_8888; // enable ch0,1,2,3,4,6 (nibble bit3)
    d.run(bus);
    for (let i = 0; i < 4; i++) expect(bus.readRam(0x1000 + i * 4)).toBe(0xaa00 + i);
  });

  test("BCR count 0 behaves as 0x10000 words (boundary)", () => {
    const bus = new TestBus();
    const d = new Dma();
    for (let i = 0; i < 0x10000; i++) bus.cdromQueue.push(0x1234);
    setupBlockRead(d, bus, 0, 0);
    d.dpcr = 0x8000; // ch3 enable (nibble 3, bit 15)
    d.run(bus);
    expect(bus.readRam(0)).toBe(0x1234);
    expect(bus.readRam((0x10000 - 1) * 4)).toBe(0x1234); // last word written
    expect(bus.readRam(0x10000 * 4)).toBe(0); // wrap did not overrun past 64K words? (wraps to 0)
  });

  test("ch4 SPU block with no hook still advances and completes", () => {
    const bus = new TestBus();
    const d = new Dma();
    seed(bus, 0x100, 0xdead_f00d);
    seed(bus, 0x101, 0x1111_2222);
    d.regs[4 * 3] = 0x400;
    d.regs[4 * 3 + 1] = 2;
    d.regs[4 * 3 + 2] = 0x1100_0000; // from RAM (drain), start
    d.dpcr = 0x8_0000; // ch4 enable (nibble 4, bit 19)
    d.request(4);
    d.run(bus);
    expect((d.regs[4 * 3 + 2]! & 0x0100_0000)).toBe(0); // start cleared
    expect((d.dicr & 0x10)).not.toBe(0); // ch4 status set
  });

  test("ch0 MDECin burst: mdecIn receives seeded RAM words in order", () => {
    const bus = new TestBus();
    const d = new Dma();
    seed(bus, 0x200, 7);
    seed(bus, 0x201, 8);
    seed(bus, 0x202, 9);
    d.regs[0] = 0x800;
    d.regs[1] = 3;
    d.regs[2] = 0x1100_0000; // from RAM, start
    d.dpcr = 0x0008; // ch0 enable (nibble 0, bit 3)
    d.request(0);
    d.run(bus);
    expect(bus.mdecInCalls).toBe(3);
    expect(bus.writes).toEqual([7, 8, 9]);
  });

  test("ch1 MDECout burst: queued mdecOut words written to RAM", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.mdecOutQueue = [0xc0de_0001, 0xc0de_0002];
    d.regs[1 * 3] = 0x2000;
    d.regs[1 * 3 + 1] = 2;
    d.regs[1 * 3 + 2] = 0x1200_0000; // to RAM, start, burst
    d.dpcr = 0x0080; // ch1 enable (nibble 1, bit 7)
    d.request(1);
    d.run(bus);
    expect(bus.readRam(0x2000)).toBe(0xc0de_0001);
    expect(bus.readRam(0x2004)).toBe(0xc0de_0002);
  });

  test("address step -4 (CHCR bit 4) walks backwards", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.mdecOutQueue = [10, 11];
    d.regs[1 * 3] = 0x2010; // ends here, next -4
    d.regs[1 * 3 + 1] = 2;
    d.regs[1 * 3 + 2] = 0x1200_0010; // to RAM, start, burst, step dec
    d.dpcr = 0x0080;
    d.request(1);
    d.run(bus);
    expect(bus.readRam(0x2010)).toBe(10);
    expect(bus.readRam(0x200c)).toBe(11);
  });

  test("MADR wraps within 2 MiB (0x1fffc + step)", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.mdecOutQueue = [42];
    d.regs[1 * 3] = 0x1f_fffc;
    d.regs[1 * 3 + 1] = 2;
    d.regs[1 * 3 + 2] = 0x1200_0000;
    d.dpcr = 0x0080;
    d.request(1);
    d.run(bus);
    expect(bus.readRam(0x1f_fffc)).toBe(42);
    expect(bus.readRam(0)).toBe(0); // wrapped to 0, second word
  });
});

describe("DMA ch2 GPU", () => {
  test("linked-list walk feeds gpuWrite and stops at 0xFFFFFF terminator", () => {
    const bus = new TestBus();
    const d = new Dma();
    // node0 @ 0x200: hdr = next 0x400 | 2 words; node1 @ 0x400: terminator | 1 word
    seed(bus, 0x80, 0x0200_0400); // hdr @ 0x200
    seed(bus, 0x81, 0xaaaa_0001);
    seed(bus, 0x82, 0xaaaa_0002);
    seed(bus, 0x100, 0x01ff_ffff); // hdr @ 0x400: next=terminator, 1 word
    seed(bus, 0x101, 0xbbbb_0003);
    d.regs[2 * 3] = 0x200;
    d.regs[2 * 3 + 2] = 0x0100_0400 | 0x0100_0000; // sync=2 list, start
    d.dpcr = 0x0800; // ch2 enable (nibble 2, bit 11)
    d.request(2);
    d.run(bus);
    expect(bus.writes).toEqual([0xaaaa_0001, 0xaaaa_0002, 0xbbbb_0003]);
    expect((d.regs[2 * 3 + 2]! & 0x0100_0000)).toBe(0);
    expect((d.dicr & 0x04)).not.toBe(0);
  });

  test("linked-list with words=0 header advances to next node only", () => {
    const bus = new TestBus();
    const d = new Dma();
    seed(bus, 0x40, 0x0000_0300); // @0x100: 0 words, next 0x300
    seed(bus, 0xc0, 0x02ff_ffff); // @0x300: terminator, 2 words
    seed(bus, 0xc1, 0x1111);
    seed(bus, 0xc2, 0x2222);
    d.regs[2 * 3] = 0x100;
    d.regs[2 * 3 + 2] = 0x0100_0400 | 0x0100_0000;
    d.dpcr = 0x0800;
    d.request(2);
    d.run(bus);
    expect(bus.writes).toEqual([0x1111, 0x2222]);
  });

  test("ch2 block mode sends words to gpuWrite", () => {
    const bus = new TestBus();
    const d = new Dma();
    seed(bus, 0x300, 0x0300_0000); // GP0 fill command word
    seed(bus, 0x301, 0x00ff_00ff);
    d.regs[2 * 3] = 0xc00;
    d.regs[2 * 3 + 1] = 2;
    d.regs[2 * 3 + 2] = 0x1100_0000; // from RAM, burst (NOT list)
    d.dpcr = 0x0800;
    d.request(2);
    d.run(bus);
    expect(bus.writes).toEqual([0x0300_0000, 0x00ff_00ff]);
  });
});

describe("DMA ch6 OTC", () => {
  test("builds reverse table ending in terminator", () => {
    const bus = new TestBus();
    const d = new Dma();
    d.regs[6 * 3] = 0x1010;
    d.regs[6 * 3 + 1] = 4;
    d.regs[6 * 3 + 2] = 0x0100_0000; // start (OTC ignores sync)
    d.dpcr = 0x4000_0000; // ch6 enable (nibble 6, bit 27)
    d.request(6);
    d.run(bus);
    expect(bus.readRam(0x1010)).toBe(0x100c); // addr-4
    expect(bus.readRam(0x100c)).toBe(0x1008);
    expect(bus.readRam(0x1008)).toBe(0x1004);
    expect(bus.readRam(0x1004)).toBe(0x00ff_ffff); // last = terminator
    expect((d.regs[6 * 3 + 2]! & 0x0100_0000)).toBe(0);
    expect((d.dicr & 0x40)).not.toBe(0);
  });

  test("OTC count 0 = 0x10000 entries, wraps down past 0", () => {
    const bus = new TestBus();
    const d = new Dma();
    d.regs[6 * 3] = 0x4;
    d.regs[6 * 3 + 1] = 0;
    d.regs[6 * 3 + 2] = 0x0100_0000;
    d.dpcr = 0x4000_0000;
    d.request(6);
    d.run(bus);
    expect(bus.readRam(0x4)).toBe(0); // addr=4, first next = addr-4 wrapped = 0
    expect(bus.readRam(0)).toBe(0x00ff_ffff); // last of 0x10000 entries wraps to 0
    expect(bus.readRam(0x1f_fffc)).toBe(0x1f_fffc - 4); // second-to-last region intact
  });
});

describe("DMA control (DPCR gating, DICR, enable bits)", () => {
  test("DPCR channel nibble bit3 gates execution; start bit stays set", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.cdromQueue = [77];
    setupBlockRead(d, bus, 0x1000, 1);
    d.request(3);
    d.dpcr = 0x0000; // ch3 disabled
    d.run(bus);
    expect(bus.readRam(0x1000)).toBe(0); // no transfer
    expect((d.regs[3 * 3 + 2]! & 0x0100_0000)).not.toBe(0); // still pending
    expect(d.dicr & 0x08).toBe(0);
    d.dpcr = 0x8000; // enable ch3
    d.run(bus);
    expect(bus.readRam(0x1000)).toBe(77);
    expect((d.regs[3 * 3 + 2]! & 0x0100_0000)).toBe(0);
  });

  test("request() without ctrl START still transfers (request marks start)", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.cdromQueue = [5];
    d.regs[3 * 3] = 0x2000;
    d.regs[3 * 3 + 1] = 1;
    d.regs[3 * 3 + 2] = 0x0200_0000 | 0x1100_0000; // config, no start bit yet
    d.dpcr = 0x8000;
    d.request(3);
    d.run(bus);
    expect(bus.readRam(0x2000)).toBe(5);
  });

  test("completion sets DICR status and fires raiseIrq(3) with master enable", () => {
    const bus = new TestBus();
    const d = new Dma();
    let irqLine = -1;
    let irqCount = 0;
    d.raiseIrq = (line) => { irqLine = line; irqCount++; };
    bus.cdromQueue = [1];
    setupBlockRead(d, bus, 0x0, 1);
    d.dpcr = 0x8000;
    d.writeDicr(0x00ff_ffff); // all enables + master enable + force? no: force cleared (v bit25=0)
    d.request(3);
    d.run(bus);
    expect((d.dicr & 0x08)).not.toBe(0); // ch3 status
    expect((d.dicr & 0x0100_0000)).not.toBe(0); // master flag
    expect(irqCount).toBe(1);
    expect(irqLine).toBe(3);
  });

  test("no IRQ when channel enable bit clear in DICR even with status set", () => {
    const bus = new TestBus();
    const d = new Dma();
    let fired = 0;
    d.raiseIrq = () => fired++;
    bus.cdromQueue = [1];
    setupBlockRead(d, bus, 0x0, 1);
    d.dpcr = 0x8000;
    d.writeDicr(0x0080_0000); // master enable only, ch3 enable clear
    d.request(3);
    d.run(bus);
    expect((d.dicr & 0x08)).not.toBe(0); // status latched
    expect((d.dicr & 0x0100_0000)).toBe(0); // master flag suppressed
    expect(fired).toBe(0);
  });

  test("writeDicr ack: write-1-clears status and drops master flag", () => {
    const bus = new TestBus();
    const d = new Dma();
    bus.cdromQueue = [1];
    setupBlockRead(d, bus, 0x0, 1);
    d.dpcr = 0x8000;
    d.writeDicr(0x0088_0000); // ch3 enable + master
    d.request(3);
    d.run(bus);
    expect((d.dicr & 0x0100_0000)).not.toBe(0);
    d.writeDicr(0x08); // ack ch3
    expect((d.dicr & 0x08)).toBe(0);
    expect((d.dicr & 0x0100_0000)).toBe(0); // master flag cleared too
    expect((d.dicr & 0x0080_0000)).not.toBe(0); // master ENABLE survives
    expect((d.dicr & 0x0008_0000)).not.toBe(0); // ch3 enable survives
  });

  test("DICR force bit asserts master flag and IRQ without any channel", () => {
    const bus = new TestBus();
    const d = new Dma();
    let fired = 0;
    d.raiseIrq = () => fired++;
    d.writeDicr(0x0280_0000); // force + master enable
    expect((d.dicr & 0x0100_0000)).not.toBe(0);
    expect(fired).toBe(1);
  });

  test("writeDicr enable bits are set-from-written, not OR-only", () => {
    const d = new Dma();
    d.writeDicr(0x0077_0000); // ch0,3,4,5,6 enabled (bit16,19,20,21,22... mask 0x7f)
    expect(d.dicr & 0x007f_0000).toBe(0x0077_0000);
    d.writeDicr(0x0011_0000); // rewrite: only ch0+ch4
    expect(d.dicr & 0x007f_0000).toBe(0x0011_0000);
  });

  test("multiple channels drain lowest-first in one run()", () => {
    const bus = new TestBus();
    const d = new Dma();
    seed(bus, 0x400, 0x1234);
    d.regs[1 * 3] = 0x1000;
    d.regs[1 * 3 + 1] = 1;
    d.regs[1 * 3 + 2] = 0x1200_0000; // ch1 to RAM
    bus.mdecOutQueue = [0x5a5a];
    d.regs[6 * 3] = 0x1010;
    d.regs[6 * 3 + 1] = 2;
    d.regs[6 * 3 + 2] = 0x0100_0000; // ch6 OTC
    d.dpcr = 0x4000_0080; // ch1 + ch6
    d.request(1);
    d.request(6);
    d.run(bus);
    expect(bus.readRam(0x1000)).toBe(0x5a5a);
    expect(bus.readRam(0x1010)).toBe(0x100c);
    expect(bus.readRam(0x100c)).toBe(0x00ff_ffff);
    expect(d.dicr & 0x42).toBe(0x42); // ch1 + ch6 status
  });
});
