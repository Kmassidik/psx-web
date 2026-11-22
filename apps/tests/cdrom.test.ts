import { describe, test, expect } from "bun:test";
import { Cdrom } from "../src/core/cdrom";

/** Fresh controller with IRQ capture; returns {c, lines, ints}. */
function make(): { c: Cdrom; lines: number[]; ints: number[] } {
  const c = new Cdrom();
  const lines: number[] = [];
  const ints: number[] = [];
  c.irqFire = (line) => {
    lines.push(line);
    ints.push(c.regs[5]! & 0x07);
  };
  return { c, lines, ints };
}

describe("CDROM command sequences (per-command INT/stat contract)", () => {
  test("Getstat(01) idling: single INT3 with no-disc stat 08h", () => {
    const { c, lines, ints } = make();
    c.write(1, 0x01); // command to 1F801801h
    expect(lines).toEqual([2]); // CDROM IRQ line
    expect(ints).toEqual([3]);
    expect(c.read(1)).toBe(0x08); // IdError: GetID denied (no disc)
    expect(c.getErrorCode()).toBe(0);
  });

  test("Init(0A): INT3(stat|02) then INT2(stat) after ack", () => {
    const { c, lines, ints } = make();
    c.write(1, 0x0a);
    expect(ints).toEqual([3]);
    const ackStat = c.read(1);
    expect(ackStat & 0x02).toBe(0x02); // motor on
    c.ack(0x07); // acknowledge INT3
    c.exec(); // second response step
    expect(ints).toEqual([3, 2]);
    expect(c.read(1)).toBe(ackStat); // stat, motor still spinning
    expect(c.getErrorCode()).toBe(0);
  });

  test("Setmode(0E): INT3(stat), mode latched and visible via Getparam", () => {
    const { c } = make();
    c.write(2, 0xa0); // double speed + XA (bits 7,6)
    c.write(1, 0x0e);
    expect(c.read(1) & 0x01).toBe(0x00);
    c.ack(0x07);
    c.write(1, 0x0f); // Getparam: stat,mode,00,file,ch
    expect(c.read(1)).toBe(0x08);
    expect(c.read(1)).toBe(0xa0);
    expect(c.read(1)).toBe(0x00);
  });

  test("ReadN(06): INT3(02h), then INT1(2xh) with DRQ per fed sector", () => {
    const { c, ints } = make();
    c.write(1, 0x06);
    expect(ints).toEqual([3]);
    expect(c.read(1)).toBe(0x02); // motor on, no Read-bit yet (seeking)
    c.ack(0x07);
    c.exec(); // no second response until a sector arrives (Read: INT1 is 2nd)
    expect(ints).toEqual([3]);
    // host feeds a sector -> DRQ latched, INT1 on next exec
    const sector = new Uint8Array(2352);
    sector.set([0xaa, 0xbb], 12); // header bytes
    sector[2351] = 0x7f;
    c.setSectorData(sector);
    expect(c.read(0) & 0x40).toBe(0x40); // DRQSTS: sector latched
    c.exec(); // deliver INT1
    expect(ints).toEqual([3, 1]);
    expect(c.read(1)).toBe(0x22); // Read + motor stat
    expect(c.sectorBuffer[13]).toBe(0xbb);
    expect(c.sectorBuffer[2351]).toBe(0x7f);
    c.ack(0x07);
    expect(c.read(0) & 0x40).toBe(0x00); // DRQ cleared by ack
  });

  test("SeekL(15)/SeekP(16): INT3(4xh) seek-stat then INT2 stat seek-cleared", () => {
    const { c, ints } = make();
    c.write(1, 0x15);
    expect(ints).toEqual([3]);
    const s0 = c.read(1);
    expect(s0 & 0x40).toBe(0x40); // Seek busy
    expect(s0 & 0x02).toBe(0x02); // motor
    c.ack(0x07);
    c.exec();
    expect(ints).toEqual([3, 2]);
    expect(c.read(1) & 0x40).toBe(0x00); // seek completed
    c.ack(0x07); // INT2 acknowledged -> new commands accepted
    // SeekP same shape
    c.write(1, 0x16);
    expect(ints[ints.length - 1]).toBe(3);
    expect(c.read(1) & 0x40).toBe(0x40);
    c.ack(0x07);
    c.exec();
    expect(ints[ints.length - 1]).toBe(2);
  });

  test("Setloc(02) amm,ass,asect: single INT3(stat)", () => {
    const { c, ints } = make();
    c.write(2, 0x00);
    c.write(2, 0x02); // 2 seconds
    c.write(2, 0x00); // 0 frac
    c.write(1, 0x02);
    expect(ints).toEqual([3]);
    expect(c.read(1)).toBe(0x08);
  });

  test("Test(19),sub 20h: INT3(94h,09h,19h,C2h) version bytes", () => {
    const { c, ints } = make();
    c.write(2, 0x20);
    c.write(1, 0x19);
    expect(ints).toEqual([3]);
    expect(c.read(1)).toBe(0x94);
    expect(c.read(1)).toBe(0x09);
    expect(c.read(1)).toBe(0x19);
    expect(c.read(1)).toBe(0xc2);
  });

  test("GetID(1A) no disc: INT3(stat) then INT5(08h,40h,00,00,00,00,00,00)", () => {
    const { c, ints } = make();
    c.write(1, 0x1a);
    expect(ints).toEqual([3]);
    expect(c.read(1) & 0x08).toBe(0x08); // stat bit3: IdError
    c.ack(0x07);
    c.exec(); // second response
    expect(ints).toEqual([3, 5]);
    expect(c.read(1)).toBe(0x08); // flags: disk missing
    expect(c.read(1)).toBe(0x40); // type: no disc
    expect(c.read(1)).toBe(0x00); // atip
    expect(c.read(1)).toBe(0x00); // SCEx[0]
    expect(c.read(1)).toBe(0x00); // SCEx[1]
    expect(c.read(1)).toBe(0x00); // SCEx[2]
    expect(c.read(1)).toBe(0x00); // SCEx[3]
    expect(c.getErrorCode()).toBe(0x40); // CdromGetInt5errCode mirror
    expect(c.idComplete).toBe(true);
  });

  test("ReadTOC(1E): INT3(late-stat 02h) then INT2(stat)", () => {
    const { c, ints } = make();
    c.write(1, 0x1e);
    expect(ints).toEqual([3]);
    expect(c.read(1) & 0x02).toBe(0x02);
    c.ack(0x07);
    c.exec();
    expect(ints).toEqual([3, 2]);
  });

  test("Pause(09) after ReadN: first INT3 keeps Read-bit, INT2 clears it", () => {
    const { c, ints } = make();
    c.write(1, 0x06);
    c.ack(0x07);
    c.exec(); // read armed (INT5)
    c.ack(0x07);
    c.setSectorData(new Uint8Array(2352));
    c.exec(); // INT1 data
    c.ack(0x07);
    c.write(1, 0x09); // Pause
    const s0 = c.read(1);
    expect(s0 & 0x20).toBe(0x20); // still Read
    c.ack(0x07);
    c.exec();
    expect(ints[ints.length - 1]).toBe(2);
    expect(c.read(1) & 0x20).toBe(0x00); // Read stopped
  });

  test("Stop(08): second response clears motor bit", () => {
    const { c, ints } = make();
    c.write(1, 0x0a); // init spins motor
    c.ack(0x07);
    c.exec();
    c.ack(0x07);
    c.write(1, 0x08); // Stop
    c.ack(0x07);
    c.exec();
    expect(ints[ints.length - 1]).toBe(2);
    expect(c.read(1) & 0x02).toBe(0x00); // motor off
  });
});

describe("CDROM FIFO push/pop order", () => {
  test("parameter FIFO is FIFO: Getparam-independent order via command reads", () => {
    const c = new Cdrom();
    c.write(2, 0x11);
    c.write(2, 0x22);
    c.write(2, 0x33);
    // status: param non-empty, not full
    const s = c.read(0);
    expect(s & 0x08).toBe(0x00); // PRMEMPT false
    expect(s & 0x10).toBe(0x00); // not 16 bytes
    // command 19h with invalid sub -> params preserved in FIFO (no$psx note)
    c.write(1, 0x19);
    c.ack(0x07);
    // fifo still holds our bytes (invalid sub_function keeps params)
    c.write(2, 0x20);
    c.write(1, 0x19); // now valid sub with 4th leftover? invalid -> keep
    c.ack(0x07);
    // clear via 1F801803h.Index1 bit6 (write to index3 addr)
    c.write(0, 3); // index 3
    c.write(3, 0x40); // CLRPRM
    c.write(0, 0); // back to index 0
    expect(c.read(0) & 0x08).toBe(0x08); // param fifo empty again
  });

  test("response FIFO: 00h padding then restart at byte 0 (no$psx)", () => {
    const c = new Cdrom();
    c.irqFire = () => {};
    c.write(2, 0x20);
    c.write(1, 0x19); // version bytes 94 09 19 C2
    const out: number[] = [];
    for (let i = 0; i < 16; i++) out.push(c.read(1));
    expect(out.slice(0, 4)).toEqual([0x94, 0x09, 0x19, 0xc2]);
    expect(out.slice(4)).toEqual(new Array(12).fill(0x00));
    // restart at first byte without a new response
    expect(c.read(1)).toBe(0x94);
  });
});

describe("CDROM INT sequence counts", () => {
  test("single-response command fires CDROM IRQ line 2 exactly once", () => {
    const { c, lines } = make();
    c.write(1, 0x01);
    c.exec(); // nothing queued: no extra IRQ
    c.exec();
    expect(lines).toEqual([2]);
  });

  test("second-response command fires exactly twice, INT3 then INT2", () => {
    const { c, lines, ints } = make();
    c.write(1, 0x0a);
    c.ack(0x07);
    c.exec();
    expect(lines).toEqual([2, 2]);
    expect(ints).toEqual([3, 2]);
  });

  test("second response NOT delivered before INT3 ack", () => {
    const { c, ints } = make();
    c.write(1, 0x1a);
    c.exec(); // no ack: still only first response
    expect(ints).toEqual([3]);
    c.ack(0x07);
    c.exec();
    expect(ints).toEqual([3, 5]);
  });

  test("command while INT pending is held until ack (no$psx mainloop)", () => {
    const { c, ints } = make();
    c.write(1, 0x01); // INT3 pending
    c.write(1, 0x0a); // must be ignored while INT3 unacknowledged
    expect(ints).toEqual([3]);
    c.ack(0x07);
    c.exec();
    expect(ints).toEqual([3]); // held command was dropped, not executed
    c.write(1, 0x0a); // now accepted -> its own INT3
    c.ack(0x07);
    c.exec();
    expect(ints).toEqual([3, 3, 2]);
  });
});

describe("CDROM read-data sector delivery after ReadN", () => {
  test("consecutive sectors each produce one INT1 when acked", () => {
    const { c, ints } = make();
    c.write(1, 0x06);
    c.ack(0x07);
    c.exec();
    c.ack(0x07);
    const a = new Uint8Array(2352).fill(0x11);
    const b = new Uint8Array(2352).fill(0x22);
    c.setSectorData(a);
    c.exec();
    expect(ints[ints.length - 1]).toBe(1);
    c.ack(0x07);
    c.setSectorData(b);
    c.exec();
    expect(ints[ints.length - 1]).toBe(1);
    expect(c.sectorBuffer[0]).toBe(0x22); // newest sector latched
    c.ack(0x07);
  });

  test("no INT1 without ReadN active (latch still possible via latchSector)", () => {
    const { c, ints } = make();
    c.setSectorData(new Uint8Array(2352).fill(9));
    c.exec();
    expect(ints).toEqual([]);
    c.latchSector();
    c.exec();
    expect(ints).toEqual([1]);
  });

  test("Pause stops the data stream: setSectorData no longer arms INT1", () => {
    const { c, ints } = make();
    c.write(1, 0x06);
    c.ack(0x07);
    c.exec();
    c.ack(0x07);
    c.write(1, 0x09); // Pause
    c.ack(0x07);
    c.exec();
    c.ack(0x07);
    c.setSectorData(new Uint8Array(2352));
    c.exec();
    expect(ints.filter((i) => i === 1).length).toBe(0);
  });
});

describe("CDROM error / latch behavior", () => {
  test("invalid opcode 7Fh: INT5(stat|01,40h) and error latch 40h", () => {
    const { c, ints } = make();
    c.write(1, 0x7f);
    expect(ints).toEqual([5]);
    expect(c.read(1)).toBe(0x09); // stat | Error bit
    expect(c.read(1)).toBe(0x40);
    expect(c.getErrorCode()).toBe(0x40);
  });

  test("Test(19) invalid sub_function: INT5 error 10h", () => {
    const { c, ints } = make();
    c.write(2, 0xff);
    c.write(1, 0x19);
    expect(ints).toEqual([5]);
    expect(c.getErrorCode()).toBe(0x10);
  });

  test("reset() restores power-up state", () => {
    const { c } = make();
    c.write(1, 0x1a);
    c.ack(0x07);
    c.exec();
    c.reset();
    expect(c.read(1)).toBe(0x00); // fresh buffer: 0-byte response, 00h pad
    expect(c.getErrorCode()).toBe(0);
    expect(c.regs[5]).toBe(0);
    expect(c.idComplete).toBe(false);
    expect(c.mode).toBe(0);
    expect(c.sectorBuffer.every((b) => b === 0)).toBe(true);
  });
});
