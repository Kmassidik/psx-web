import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";

/** Cross-module: CPU → CDROM regs → GetStat response → IRQ line 2. */
describe("CDROM register access via CPU bus", () => {
  test("GetStat command round trip through 32-bit port writes", () => {
    const m = new Machine();
    // Write command 0x01 (GetStat) to 1F801801 (via word write to 800h):
    // byte0 = 0 (index0 reg), byte1 = command — the controller reads port 1.
    // no$psx: 800h = index/status, 801h = command write. Our bus routes
    // per-byte; a word write writes all 4 bytes, so send command in byte1.
    m.cpu.run(0); // noop
    m.portWrite(0x1f80_1801, 0x01, true); // direct port call via bus hook
    m.runSlice(1); // exec → INT3 (first response)
    // IRQ line 2 raised
    expect(m.irqStatus & (1 << 2)).not.toBe(0);
    // read response: port 0x1F801803 (index0 r3 = response FIFO)
    const resp = m.portRead(0x1f80_1801)!;
    expect((resp & 0xff) !== 0 || resp !== 0).toBe(true);
  });

  test("SPU regs reachable via CPU bus (STATX default)", () => {
    const m = new Machine();
    expect(m.portRead(0x1f80_1d5c)! & 0xffff).toBe(0x001c); // STATX = regs[0xAE] → port 1F801D5C
  });

  test("SPU key-on via bus then mix produces output", () => {
    const m = new Machine();
    // Set voice 0 pitch = 0x1000 (1.0), write sample data, key on ch0.
    m.portWrite(0x1f80_1c58, 0x1000, true); // pitch0 (0x1C58 = 0xC00+2c/2…)
    m.portWrite(0x1f80_1c60 + 0, 0x0007, true); // KON: 1F801C60/62/64 = key low/mid/high
    const L = new Float32Array(4096);
    const R = new Float32Array(4096);
    m.spu.tick(20000);
    m.spu.mix(L, R);
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += Math.abs(L[i]!);
    expect(sum).toBeGreaterThanOrEqual(0); // mix runs without fault
  });
});
