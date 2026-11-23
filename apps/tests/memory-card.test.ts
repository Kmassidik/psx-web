import { describe, expect, test } from "bun:test";
import { Joypad, type JoypadPort } from "../src/core/joypad";
import {
  createFormattedMemoryCard,
  MEMORY_CARD_SECTOR_SIZE,
  MEMORY_CARD_SIZE,
} from "../src/core/memory-card";

const DATA = 0x1f80_1040;
const STAT = 0x1f80_1044;
const CTRL = 0x1f80_104a;
const SELECTED = 0x1003;

interface Packet {
  reply: number[];
  ack: boolean[];
}

function fixture() {
  const joy = new Joypad({ pad1: 0xffff, pad2: 0xffff });
  const irqs: number[] = [];
  joy.irqFire = (line) => irqs.push(line);
  return { joy, irqs };
}

function packet(
  joy: Joypad,
  address: number,
  command: number,
  tail: number[],
  port: JoypadPort = 0,
): Packet {
  joy.write(CTRL, 0);
  joy.write(CTRL, SELECTED | (port << 13));
  const reply: number[] = [];
  const ack: boolean[] = [];
  for (const tx of [address, command, ...tail]) {
    joy.write(DATA, tx);
    joy.tick(100);
    reply.push(joy.read(DATA)!);
    ack.push((joy.read(STAT)! & 0x80) !== 0);
    joy.write(CTRL, joy.read(CTRL)! | 0x10);
  }
  joy.write(CTRL, 0);
  return { reply, ack };
}

function checksum(sector: number, data: Uint8Array): number {
  let value = (sector >>> 8) ^ (sector & 0xff);
  for (const byte of data) value ^= byte;
  return value;
}

function readSector(joy: Joypad, sector: number, port: JoypadPort = 0): Packet {
  return packet(joy, 0x81, 0x52, [
    0, 0, (sector >>> 8) & 0xff, sector & 0xff,
    ...new Array<number>(134).fill(0),
  ], port);
}

function writeSector(
  joy: Joypad,
  sector: number,
  data: Uint8Array,
  sentChecksum = checksum(sector, data),
  port: JoypadPort = 0,
): Packet {
  return packet(joy, 0x81, 0x57, [
    0, 0, (sector >>> 8) & 0xff, sector & 0xff,
    ...data, sentChecksum, 0, 0, 0,
  ], port);
}

function getId(joy: Joypad, port: JoypadPort = 0): Packet {
  return packet(joy, 0x81, 0x53, new Array<number>(8).fill(0), port);
}

describe("standard SIO0 memory card protocol", () => {
  test("empty slots float high without ACK or IRQ", () => {
    const { joy, irqs } = fixture();
    const result = getId(joy);
    expect(result.reply).toEqual(new Array<number>(10).fill(0xff));
    expect(result.ack).toEqual(new Array<boolean>(10).fill(false));
    expect(irqs).toEqual([]);
    expect(joy.exportMemoryCard(0)).toBeUndefined();
    expect(joy.formatMemoryCard(0)).toBe(false);
  });

  test("attach creates a valid formatted image and slots are independent", () => {
    const { joy } = fixture();
    joy.attachMemoryCard(0);
    joy.attachMemoryCard(1);
    const first = joy.exportMemoryCard(0)!;
    const second = joy.exportMemoryCard(1)!;
    expect(first).toEqual(createFormattedMemoryCard());
    expect(second).toEqual(first);
    expect(first).toHaveLength(MEMORY_CARD_SIZE);
    expect(Array.from(first.slice(0, 2))).toEqual([0x4d, 0x43]);
    expect(Array.from(first.slice(63 * 128, 63 * 128 + 2))).toEqual([0x4d, 0x43]);
    for (let frame = 1; frame <= 15; frame++) {
      const offset = frame * 128;
      expect(first[offset]).toBe(0xa0);
      expect(first[offset + 8]).toBe(0xff);
      expect(first[offset + 9]).toBe(0xff);
    }
    for (let frame = 0; frame < 64; frame++) {
      let value = 0;
      for (const byte of first.slice(frame * 128, (frame + 1) * 128)) value ^= byte;
      expect(value).toBe(0);
    }

    joy.detachMemoryCard(0);
    expect(joy.exportMemoryCard(0)).toBeUndefined();
    expect(joy.exportMemoryCard(1)).toEqual(second);
  });

  test("Get ID reports capacity, sector size, and fresh-card FLAG", () => {
    const { joy, irqs } = fixture();
    joy.attachMemoryCard(0);
    const result = getId(joy);
    expect(result.reply).toEqual([0xff, 0x08, 0x5a, 0x5d, 0x5c, 0x5d, 0x04, 0, 0, 0x80]);
    expect(result.ack).toEqual([...new Array<boolean>(9).fill(true), false]);
    expect(irqs).toEqual(new Array<number>(9).fill(7));
  });

  test("reads a sector with confirmed address, data checksum, and ACK/IRQ", () => {
    const { joy, irqs } = fixture();
    joy.attachMemoryCard(0);
    const result = readSector(joy, 0);
    expect(result.reply.slice(0, 10)).toEqual([0xff, 0x08, 0x5a, 0x5d, 0, 0, 0x5c, 0x5d, 0, 0]);
    expect(result.reply.slice(10, 138)).toEqual(Array.from(createFormattedMemoryCard().slice(0, 128)));
    expect(result.reply[138]).toBe(0);
    expect(result.reply[139]).toBe(0x47);
    expect(result.ack.slice(0, 139).every(Boolean)).toBe(true);
    expect(result.ack[139]).toBe(false);
    expect(irqs).toHaveLength(139);
    expect(irqs.every((line) => line === 7)).toBe(true);
  });

  test("writes and reads back a checksummed sector on either slot", () => {
    const { joy } = fixture();
    joy.attachMemoryCard(1);
    const sector = 0x12a;
    const data = Uint8Array.from({ length: MEMORY_CARD_SECTOR_SIZE }, (_, i) => (i * 37 + 11) & 0xff);
    const written = writeSector(joy, sector, data, undefined, 1);
    expect(written.reply.slice(-3)).toEqual([0x5c, 0x5d, 0x47]);
    expect(written.ack.slice(0, -1).every(Boolean)).toBe(true);
    expect(written.ack.at(-1)).toBe(false);
    expect(getId(joy, 1).reply[1]).toBe(0);

    const read = readSector(joy, sector, 1);
    expect(read.reply.slice(8, 10)).toEqual([sector >>> 8, sector & 0xff]);
    expect(read.reply.slice(10, 138)).toEqual(Array.from(data));
    expect(read.reply[138]).toBe(checksum(sector, data));
    expect(read.reply[139]).toBe(0x47);
    expect(joy.exportMemoryCard(1)!.slice(sector * 128, (sector + 1) * 128)).toEqual(data);
  });

  test("rejects a bad write checksum without changing any card byte", () => {
    const { joy } = fixture();
    joy.attachMemoryCard(0);
    const before = joy.exportMemoryCard(0)!;
    const data = new Uint8Array(128).fill(0x6b);
    const result = writeSector(joy, 64, data, checksum(64, data) ^ 0x80);
    expect(result.reply.at(-1)).toBe(0x4e);
    expect(result.ack.at(-1)).toBe(false);
    expect(joy.exportMemoryCard(0)).toEqual(before);
    expect(getId(joy).reply[1]).toBe(0x08);
  });

  test("aborts invalid reads and reports invalid writes without wrapping sectors", () => {
    const { joy } = fixture();
    joy.attachMemoryCard(0);
    const before = joy.exportMemoryCard(0)!;
    const read = readSector(joy, 0x400);
    expect(read.reply.slice(0, 10)).toEqual([0xff, 0x08, 0x5a, 0x5d, 0, 4, 0x5c, 0x5d, 0xff, 0xff]);
    expect(read.reply.slice(10)).toEqual(new Array<number>(130).fill(0xff));
    expect(read.ack.slice(0, 9).every(Boolean)).toBe(true);
    expect(read.ack.slice(9).every((ack) => !ack)).toBe(true);

    const data = new Uint8Array(128).fill(0x42);
    const write = writeSector(joy, 0x400, data);
    expect(write.reply.at(-1)).toBe(0xff);
    expect(joy.exportMemoryCard(0)).toEqual(before);
    expect(readSector(joy, 0).reply.slice(10, 138)).toEqual(Array.from(before.slice(0, 128)));
  });

  test("import and export copy bytes and format restores a valid card", () => {
    const { joy } = fixture();
    const imported = new Uint8Array(MEMORY_CARD_SIZE).fill(0x5a);
    joy.importMemoryCard(0, imported);
    imported.fill(0);
    expect(joy.exportMemoryCard(0)![0]).toBe(0x5a);

    const exported = joy.exportMemoryCard(0)!;
    exported[0] = 0x11;
    expect(joy.exportMemoryCard(0)![0]).toBe(0x5a);
    expect(() => joy.importMemoryCard(1, new Uint8Array(12))).toThrow(RangeError);
    expect(joy.exportMemoryCard(1)).toBeUndefined();

    expect(joy.formatMemoryCard(0)).toBe(true);
    expect(joy.exportMemoryCard(0)).toEqual(createFormattedMemoryCard());
    expect(getId(joy).reply[1]).toBe(0x08);
  });

  test("controllers and cards coexist on both physical ports", () => {
    const { joy } = fixture();
    joy.attachMemoryCard(0);
    joy.attachMemoryCard(1);
    for (const port of [0, 1] as const) {
      expect(packet(joy, 0x01, 0x42, [0, 0, 0], port).reply)
        .toEqual([0xff, 0x41, 0x5a, 0xff, 0xff]);
      expect(getId(joy, port).reply.slice(0, 4)).toEqual([0xff, 0x08, 0x5a, 0x5d]);
    }

    joy.setConnected(0, false);
    expect(packet(joy, 0x01, 0x42, [0, 0, 0]).reply).toEqual(new Array<number>(5).fill(0xff));
    expect(getId(joy).reply[1]).toBe(0x08);
    joy.detachMemoryCard(1);
    expect(packet(joy, 0x01, 0x42, [0, 0, 0], 1).reply[1]).toBe(0x41);
    expect(getId(joy, 1).reply).toEqual(new Array<number>(10).fill(0xff));
  });
});
