/**
 * PS1 memory map — the one source of truth for address translation.
 * Mirrors the reference binary's init_memory_handler/init_psx_memory behavior:
 *   psxRAM 2 MiB, psxPARALLEL 128 KiB, psxSCRATCHPAD 1 KiB, psxBIOS 512 KiB.
 * All emulation state lives in preallocated buffers (low-RAM rule: zero
 * per-frame allocation, no JS object graphs for emulator memory).
 */

/** Region kinds a virtual address can resolve to. */
export const enum Region {
  Scratchpad = 0, // 1 KiB, fastest
  Ram = 1, // 2 MiB, mirrored every 2 MiB up to 0x80000000
  Parallel = 2, // 128 KiB expansion (mirrored per 8 KiB window), POST status
  Spu = 3, // 0x1F801000..0x1F801FFF voice/reg window
  MinRegs = 4, // 0x1F801000..0x1F801FFF non-SPU windows (handled per-offset)
  Bios = 5, // 512 KiB at 0xBFC00000 (KSEG1), 0x1FC00000 physical
}

/** Fixed capacities, bytes — match init_psx_memory exactly. */
export const RAM_SIZE = 0x20_0000; // 2 MiB
export const PARALLEL_SIZE = 0x2_0000; // 128 KiB
export const SCRATCHPAD_SIZE = 0x400; // 1 KiB
export const BIOS_SIZE = 0x8_0000; // 512 KiB (fread(psxBIOS,1,0x80000))

const RAM_MASK = RAM_SIZE - 1;
const PARALLEL_MASK = PARALLEL_SIZE - 1;
const SCRATCH_MASK = SCRATCHPAD_SIZE - 1;
const BIOS_MASK = BIOS_SIZE - 1;

/**
 * Translate a CPU virtual address to a physical address and region.
 * Total cost: two integer ops — safe for the interpreter hot path.
 *
 * PS1 map (KUSEG 0x00000000-0x7FFFFFFF = KSEG0 0x80000000 = KSEG1 0xA0000000):
 *   0x00000000..0x001FFFFF  RAM (mirrored to 0x7FFFFFFF every 2 MiB)
 *   0x1F000000..0x1F7FFFFF  expansion parallel port (mirrored per 8 KiB)
 *   0x1F801000..0x1F801FFF  I/O ports (SPU + peripherals)
 *   0x1F800000..0x1F8003FF  data scratchpad
 *   0x1FC00000..0x1FC7FFFF  BIOS ROM
 *   KSEG2 0xFFFE0000..      I-cache control (4 bytes; intentional trap here)
 */
export function translate(va: number): { region: Region; phys: number } {
  // KUSEG: phys = va. KSEG0: phys = va & 0x7fffffff.
  // KSEG1 (0xA0000000..0xBFFFFFFF): phys = va - 0xA0000000, so 0xBFC00000
  // reaches BIOS at 0x1FC00000 and RAM mirrors stay identical.
  const phys32 = va >= 0xa000_0000 ? va - 0xa000_0000 : va & 0x7fff_ffff;
  const top = phys32 >>> 24; // 0..127, 64KiB granularity inside low regions
  // RAM: everything below 0x00800000 is RAM-mirrored; the region is empty above.
  if (phys32 < 0x0080_0000) return { region: Region.Ram, phys: phys32 & RAM_MASK };
  if (phys32 >= 0x1f80_0000 && phys32 <= 0x1f80_03ff) {
    return { region: Region.Scratchpad, phys: phys32 & SCRATCH_MASK };
  }
  if (phys32 >= 0x1f80_1000 && phys32 <= 0x1f80_1fff) {
    return { region: Region.MinRegs, phys: phys32 - 0x1f80_1000 };
  }
  if (phys32 >= 0x1fc0_0000 && phys32 <= 0x1fc7_ffff) {
    return { region: Region.Bios, phys: phys32 & BIOS_MASK };
  }
  if (phys32 >= 0x1f00_0000 && phys32 <= 0x1f7f_ffff) {
    // parallel port: ePSXe mirrors its 128KiB buffer across 8KiB windows.
    return { region: Region.Parallel, phys: phys32 & PARALLEL_MASK };
  }
  // KSEG2 I-cache config (0xFFFE0000+): rejected — not RAM, trap for now.
  void top;
  return { region: -1 as Region, phys: phys32 };
}

/** Emulator memory container. One instance per machine. */
export class Memory {
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly parallel = new Uint8Array(PARALLEL_SIZE);
  readonly scratchpad = new Uint8Array(SCRATCHPAD_SIZE);
  readonly bios = new Uint8Array(BIOS_SIZE);

  constructor() {
    // init_psx_memory: memset(psxRAM,0,2MiB); memset(psxPARALLEL,0xff,128KiB);
    // scratchpad/ICacheIdx zeroed. (Uint8Array is already 0; parallel = 0xff.)
    this.parallel.fill(0xff);
  }

  load8(va: number): number {
    const { region, phys } = translate(va);
    switch (region) {
      case Region.Ram: return this.ram[phys]!;
      case Region.Bios: return this.bios[phys]!;
      case Region.Parallel: return this.parallel[phys]!;
      case Region.Scratchpad: return this.scratchpad[phys]!;
      default: return 0; // MinRegs/unknown: MMIO handled by bus layer in Phase 3
    }
  }
  load32(va: number): number {
    const { region, phys } = translate(va);
    switch (region) {
      case Region.Ram: return (this.ram[phys]! | (this.ram[phys + 1]! << 8) | (this.ram[phys + 2]! << 16) | (this.ram[phys + 3]! << 24)) >>> 0;
      case Region.Bios: return (this.bios[phys]! | (this.bios[phys + 1]! << 8) | (this.bios[phys + 2]! << 16) | (this.bios[phys + 3]! << 24)) >>> 0;
      case Region.Parallel: return (this.parallel[phys]! | (this.parallel[phys + 1]! << 8) | (this.parallel[phys + 2]! << 16) | (this.parallel[phys + 3]! << 24)) >>> 0;
      case Region.Scratchpad: return (this.scratchpad[phys]! | (this.scratchpad[phys + 1]! << 8) | (this.scratchpad[phys + 2]! << 16) | (this.scratchpad[phys + 3]! << 24)) >>> 0;
      default: return 0;
    }
  }
  store8(va: number, v: number): void {
    const { region, phys } = translate(va);
    switch (region) {
      case Region.Ram: this.ram[phys] = v & 0xff; return;
      case Region.Scratchpad: this.scratchpad[phys] = v & 0xff; return;
      case Region.Parallel: this.parallel[phys] = v & 0xff; return;
      default: return;
    }
  }
  store32(va: number, v: number): void {
    const { region, phys } = translate(va);
    switch (region) {
      case Region.Ram:
        this.ram[phys] = v & 0xff; this.ram[phys + 1] = (v >>> 8) & 0xff;
        this.ram[phys + 2] = (v >>> 16) & 0xff; this.ram[phys + 3] = (v >>> 24) & 0xff;
        return;
      case Region.Scratchpad:
        this.scratchpad[phys] = v & 0xff; this.scratchpad[phys + 1] = (v >>> 8) & 0xff;
        this.scratchpad[phys + 2] = (v >>> 16) & 0xff; this.scratchpad[phys + 3] = (v >>> 24) & 0xff;
        return;
      case Region.Parallel:
        this.parallel[phys] = v & 0xff; this.parallel[phys + 1] = (v >>> 8) & 0xff;
        this.parallel[phys + 2] = (v >>> 16) & 0xff; this.parallel[phys + 3] = (v >>> 24) & 0xff;
        return;
      default: return; // ROM/MMIO writes: ignored (BIOS is read-only here)
    }
  }
}
