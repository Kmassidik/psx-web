import { describe, expect, test } from "bun:test";
import { Joypad, type JoypadPort } from "../src/core/joypad";

const DATA = 0x1f80_1040;
const STAT = 0x1f80_1044;
const MODE = 0x1f80_1048;
const CTRL = 0x1f80_104a;
const BAUD = 0x1f80_104e;
const SELECTED = 0x1003; // DSRIEN | TXEN | DTR

interface Packet {
  reply: number[];
  ack: boolean[];
}

function fixture() {
  const pads = { pad1: 0xffff, pad2: 0xffff };
  const joy = new Joypad(pads);
  const irqs: number[] = [];
  joy.irqFire = (line) => irqs.push(line);
  return { joy, pads, irqs };
}

function packet(joy: Joypad, command: number, tail: number[], port: JoypadPort = 0): Packet {
  joy.write(CTRL, 0);
  joy.write(CTRL, SELECTED | (port << 13));
  const reply: number[] = [];
  const ack: boolean[] = [];
  for (const tx of [0x01, command, ...tail]) {
    joy.write(DATA, tx);
    reply.push(joy.read(DATA)!);
    ack.push((joy.read(STAT)! & 0x80) !== 0);
    joy.write(CTRL, joy.read(CTRL)! | 0x10); // acknowledge /ACK and STAT.9
  }
  joy.write(CTRL, 0);
  return { reply, ack };
}

function normal(joy: Joypad, command: number, values: number[] = [], analog = false): Packet {
  const tail = [0, ...values];
  while (tail.length < (analog ? 7 : 3)) tail.push(0);
  return packet(joy, command, tail);
}

function configure(joy: Joypad, command: number, values: number[] = []): Packet {
  const tail = [0, ...values];
  while (tail.length < 7) tail.push(0);
  return packet(joy, command, tail);
}

function enterConfig(joy: Joypad, analog = false): void {
  normal(joy, 0x43, [1], analog);
}

function digital(joy: Joypad, small = 0, large = 0): Packet {
  return normal(joy, 0x42, [small, large]);
}

describe("SIO0 digital controller", () => {
  test("returns ID and little-endian active-low buttons with release/re-press", () => {
    const { joy, pads } = fixture();
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0xff, 0xff]);

    pads.pad1 = 0xffbf; // X
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0xbf, 0xff]);
    pads.pad1 = 0xffff;
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0xff, 0xff]);

    pads.pad1 = 0xffff & ~((1 << 3) | (1 << 4) | (1 << 7) | (1 << 14));
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0x67, 0xbf]);
  });

  test("selects port 2 independently", () => {
    const { joy, pads } = fixture();
    pads.pad1 = 0xffbf;
    pads.pad2 = 0xdff7; // Start and Circle
    expect(packet(joy, 0x42, [0, 0, 0], 1).reply)
      .toEqual([0xff, 0x41, 0x5a, 0xf7, 0xdf]);
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0xbf, 0xff]);
  });

  test("ACKs every byte except the last and raises enabled IRQ7", () => {
    const { joy, irqs } = fixture();
    const result = digital(joy);
    expect(result.ack).toEqual([true, true, true, true, false]);
    expect(irqs).toEqual([7, 7, 7, 7]);

    joy.write(CTRL, SELECTED);
    joy.write(DATA, 0x01);
    expect(joy.read(STAT)! & 0x280).toBe(0x280);
    joy.write(CTRL, joy.read(CTRL)! | 0x10);
    expect(joy.read(STAT)! & 0x280).toBe(0);
    joy.write(CTRL, 0);

    const irqCountBeforeDisabledTransfer = irqs.length;
    joy.write(CTRL, 0x0003); // same transfer with DSR interrupts disabled
    joy.write(DATA, 0x01);
    expect(joy.read(STAT)! & 0x280).toBe(0x80);
    expect(irqs).toHaveLength(irqCountBeforeDisabledTransfer);
    joy.write(CTRL, 0);
    expect(joy.read(STAT)! & 0x280).toBe(0);
  });

  test("RXRDY follows the FIFO and TX requires TXEN and chip select", () => {
    const { joy, irqs } = fixture();
    joy.write(DATA, 0x01);
    expect(joy.read(DATA)).toBe(0xff);
    expect(irqs).toHaveLength(0);

    joy.write(CTRL, SELECTED);
    joy.write(DATA, 0x01);
    expect(joy.read(STAT)! & 2).toBe(2);
    expect(joy.read(DATA)).toBe(0xff);
    expect(joy.read(STAT)! & 2).toBe(0);
    expect(joy.read(DATA)).toBe(0xff);
  });

  test("disconnected ports float high without ACK or IRQ", () => {
    const { joy, irqs } = fixture();
    joy.setConnected(0, false);
    const result = digital(joy);
    expect(result.reply).toEqual([0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(result.ack).toEqual([false, false, false, false, false]);
    expect(irqs).toEqual([]);

    joy.setConnected(0, true);
    expect(digital(joy).reply).toEqual([0xff, 0x41, 0x5a, 0xff, 0xff]);
  });

  test("mode, baud, control masking and reset remain deterministic", () => {
    const { joy } = fixture();
    joy.write(MODE, 0xffff);
    joy.write(BAUD, 0x1234);
    expect(joy.read(MODE)).toBe(0x013f);
    expect(joy.read(BAUD)).toBe(0x1234);
    joy.write(CTRL, SELECTED);
    joy.write(DATA, 1);
    joy.write(CTRL, 0x40);
    expect(joy.read(MODE)).toBe(0);
    expect(joy.read(CTRL)).toBe(0);
    expect(joy.read(BAUD)).toBe(0x88);
    expect(joy.read(STAT)).toBe(0x05);
    expect(joy.read(DATA)).toBe(0xff);
  });
});

describe("dual-shock analog and configuration protocol", () => {
  test("enters config, enables analog, and returns axes in wire order", () => {
    const { joy } = fixture();
    joy.setAxes(0, [-1, 0, 1, 0]);
    enterConfig(joy);
    expect(configure(joy, 0x44, [1, 3]).reply)
      .toEqual([0xff, 0xf3, 0x5a, 0, 0, 0, 0, 0, 0]);
    expect(configure(joy, 0x45).reply)
      .toEqual([0xff, 0xf3, 0x5a, 1, 2, 1, 2, 1, 0]);
    configure(joy, 0x43, [0]);
    const result = normal(joy, 0x42, [], true);
    expect(result.reply).toEqual([0xff, 0x73, 0x5a, 0xff, 0xff, 0, 0x80, 0xff, 0x80]);
    expect(result.ack).toEqual([true, true, true, true, true, true, true, true, false]);
  });

  test("config reads force analog data even while LED mode is digital", () => {
    const { joy, pads } = fixture();
    joy.setAxes(0, [2, -2, Number.NaN, 0]);
    pads.pad1 = 0xfff7; // Start
    enterConfig(joy);
    expect(configure(joy, 0x42).reply)
      .toEqual([0xff, 0xf3, 0x5a, 0xf7, 0xff, 0xff, 0, 0x80, 0x80]);
  });

  test("manual analog switching honors the software lock", () => {
    const { joy } = fixture();
    joy.setAnalogMode(0, true);
    expect(normal(joy, 0x42, [], true).reply[1]).toBe(0x73);
    enterConfig(joy, true);
    configure(joy, 0x44, [0, 3]);
    configure(joy, 0x43, [0]);
    joy.setAnalogMode(0, true);
    expect(digital(joy).reply[1]).toBe(0x41);
  });

  test("returns documented variable configuration responses", () => {
    const { joy } = fixture();
    enterConfig(joy);
    expect(configure(joy, 0x46, [0]).reply.slice(3))
      .toEqual([0, 0, 1, 2, 0, 0x0a]);
    expect(configure(joy, 0x46, [1]).reply.slice(3))
      .toEqual([0, 0, 1, 1, 1, 0x14]);
    expect(configure(joy, 0x47).reply.slice(3)).toEqual([0, 0, 2, 0, 1, 0]);
    expect(configure(joy, 0x4c, [0]).reply.slice(3)).toEqual([0, 0, 0, 4, 0, 0]);
    expect(configure(joy, 0x4c, [1]).reply.slice(3)).toEqual([0, 0, 0, 7, 0, 0]);
    expect(configure(joy, 0x48, [1]).reply.slice(3)).toEqual([0, 0, 0, 0, 1, 0]);
  });

  test("unlocks both motors and reports changes without host dependencies", () => {
    const { joy } = fixture();
    const events: Array<[number, boolean, number]> = [];
    joy.rumble = (port, small, large) => events.push([port, small, large]);
    enterConfig(joy);
    expect(configure(joy, 0x4d, [0, 1, 0xff, 0xff, 0xff, 0xff]).reply)
      .toEqual([0xff, 0xf3, 0x5a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    configure(joy, 0x43, [0]);

    digital(joy, 1, 0xa0);
    expect(events).toEqual([[0, true, 0xa0]]);
    digital(joy);
    expect(events).toEqual([[0, true, 0xa0], [0, false, 0]]);
  });

  test("supports legacy small-motor control and stops on disconnect", () => {
    const { joy } = fixture();
    const events: Array<[boolean, number]> = [];
    joy.rumble = (_port, small, large) => events.push([small, large]);
    digital(joy, 0x40, 1);
    expect(events).toEqual([[true, 0]]);
    joy.setConnected(0, false);
    expect(events).toEqual([[true, 0], [false, 0]]);
  });
});
