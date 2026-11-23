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
    m.portWrite(0x1f80_1801, 0x01, 32); // direct port call via bus hook
    m.runSlice(1); // exec → INT3 (first response)
    // IRQ line 2 raised
    expect(m.irqStatus & (1 << 2)).not.toBe(0);
    // read response: port 0x1F801803 (index0 r3 = response FIFO)
    const resp = m.portRead(0x1f80_1801)!;
    expect((resp & 0xff) !== 0 || resp !== 0).toBe(true);
  });

  test("SPU STATX reflects ATTR IRQ enable through the bus", () => {
    const m = new Machine();
    m.portWrite(0x1f80_1daa, 0x40, 16);
    expect(m.portRead(0x1f80_1dae)! & 0x40).toBe(0x40);
  });

  test("SPU key-on via bus starts voice zero", () => {
    const m = new Machine();
    m.portWrite(0x1f80_1c04, 0x1000, 16); // voice 0 pitch
    m.portWrite(0x1f80_1d88, 1, 16); // KON voice 0
    expect(m.spu.voices[0]!.env.phase).toBe("attack");
    expect(m.spu.readVoice(0, 2)).toBe(0x1000);
  });
});
