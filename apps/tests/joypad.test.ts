import { describe, expect, test } from "bun:test";
import { Machine } from "../src/core/machine";

function readCommand(m: Machine): number[] {
  const result: number[] = [];
  for (const tx of [0x01, 0x42, 0x00, 0x00, 0x00]) {
    m.portWrite(0x1f80_1040, tx, 8);
    result.push(m.portRead(0x1f80_1040)! & 0xff);
  }
  return result;
}

describe("SIO0 digital controller", () => {
  test("serial read returns digital ID and active-low buttons", () => {
    const m = new Machine();
    m.pads.pad1 = 0xffbf; // X pressed
    expect(readCommand(m)).toEqual([0xff, 0x41, 0x5a, 0xbf, 0xff]);
    expect(m.portRead(0x1f80_1044)! & 2).toBe(0);
  });

  test("RX status reports queued response bytes", () => {
    const m = new Machine();
    m.portWrite(0x1f80_1040, 1, 8);
    expect(m.portRead(0x1f80_1044)! & 2).toBe(2);
    expect(m.portRead(0x1f80_1040)).toBe(0xff);
    expect(m.portRead(0x1f80_1044)! & 2).toBe(0);
  });
});
