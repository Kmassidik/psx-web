/**
 * Hand-assembled homebrew PS-X EXE used as the Phase-1 boot target.
 * Draws a solid green screen through three GP0 stores (FillVRAM command),
 * then spins in a tight loop — the ePSXe `load_psexe` → run pipeline,
 * exercised end to end without a BIOS.
 */
const GP0 = 0x1f80_1810;

function lui(rt: number, imm: number): number {
  return ((0x0f << 26) | (rt << 16) | (imm & 0xffff)) >>> 0;
}
function ori(rt: number, rs: number, imm: number): number {
  return ((0x0d << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
}
function sw(rt: number, rs: number, off: number): number {
  return ((0x2b << 26) | (rs << 21) | (rt << 16) | (off & 0xffff)) >>> 0;
}
function j(target: number): number {
  return ((0x02 << 26) | ((target >>> 2) & 0x3ff_ffff)) >>> 0;
}

export const HELLO_PC = 0x8001_0000;

export function buildHelloExe(rgb24 = 0x00_ff_00): { bytes: Uint8Array; pc0: number; t_addr: number } {
  const code: number[] = [
    lui(8, 0x1f80), // t0 = 0x1F800000 (GP0 base segment)
    ori(8, 8, 0x1810), // t0 = GP0
    lui(9, 0x0200 | ((rgb24 >>> 16) & 0xff)), // t1 = 0x0200Bb00 (cmd + blue byte)
    ori(9, 9, rgb24 & 0xffff), // t1 |= GgRr
    sw(9, 8, 0), // GP0 = color command
    sw(0, 8, 0), // GP0 = x:0 y:0
    lui(10, 0x01ff), // t2 = size word: h=511 (0x1FF = full 512-row fill)
    ori(10, 10, 0x03ff), // t2 |= w=1023 → rounds up to 1024 (0x400) per no$psx
    sw(10, 8, 0), // GP0 = size → fill executes
  ];
  // loop: j self + nop, at 0x80010000 + 9*4 = 0x80010024
  const loopAddr = HELLO_PC + code.length * 4;
  code.push(j(loopAddr), 0);

  const bytes = new Uint8Array(0x800 + code.length * 4);
  const dv = new DataView(bytes.buffer);
  new TextEncoder().encodeInto("PS-X EXE", bytes.subarray(0, 8));
  dv.setUint32(0x10, HELLO_PC, true); // pc0
  dv.setUint32(0x18, HELLO_PC, true); // t_addr
  dv.setUint32(0x1c, code.length * 4, true); // t_size
  code.forEach((w, i) => dv.setUint32(0x800 + i * 4, w, true));
  return { bytes, pc0: HELLO_PC, t_addr: HELLO_PC & 0x1f_ffff };
}
