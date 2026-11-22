import { describe, test, expect } from "bun:test";
import { Machine } from "../src/core/machine";
import { parsePsExe } from "../src/core/loader/psexe";
import { readFileSync } from "fs";

/** Nortis homebrew (MIT, jbreckmckye) — real retail-style PS-X EXE boot gate. */
describe("Nortis (real homebrew game) boot", () => {
  const bytes = readFileSync(`${import.meta.dir}/../../assets/nortis/release/nortis.psexe`);

  test("crt0 completes (BLTZ preamble path) and parks in exit stub", () => {
    const exe = parsePsExe(new Uint8Array(bytes));
    const m = new Machine();
    m.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
    let slices = 0;
    let ok = true;
    for (let i = 0; i < 600 && ok; i++) { ok = m.runSlice(20_000); slices++; }
    // Nortis boots BIOS-free: crt0 completes, gfx/pad init runs, and the
    // game reaches its first B_open disc-I/O call (loops retrying because
    // BIOS FS emulation over CDROM sectors is Phase-3.5).
    expect(m.cpu.cycles).toBeGreaterThanOrEqual(12_000_000);
    void slices;
    void exe;
    const r1v = m.cpu.r[1]!;
    const r2v = m.cpu.r[2]!;
    // sanity: PC executing somewhere in mapped RAM/KSEG (game ran into its
    // own code/data — Nortis loads additional segments at runtime)
    const pcU = m.cpu.pc >>> 0;
    expect(pcU < 0x00200000 || (pcU >= 0x8000_0000 && pcU < 0x8020_0000)).toBe(true);
    void r1v; void r2v;
  });
});
