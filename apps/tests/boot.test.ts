import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";
import { buildHelloExe, HELLO_PC } from "../src/core/hello-exe";
import { parsePsExe } from "../src/core/loader/psexe";

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
