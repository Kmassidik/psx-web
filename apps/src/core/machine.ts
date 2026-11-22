/** IRQ line bits (I_STAT/I_MASK map, per no$psx interrupt register). */
export const IRQ_CDROM = 1 << 2; // line 2
export const IRQ_DMA = 1 << 3; // line 3 (DMA finish)
export const IRQ_TIMERS = 1 << 4 | 1 << 5 | 1 << 6; // lines 4,5,6 (rcnt 0,1,2)
export const IRQ_SPU = 1 << 9; // line 9
export const IRQ_VBLANK = 1 << 0; // line 0

/**
 * Machine = Memory + CPU + Gpu + Rcnt + minimal DMA/IRQ wired as MMIO ports.
 * Port map (per PS1 doc + binary's CdromIoIrqFunc* family layout):
 *   0x1F801070 IRQ status, 0x1F801074 IRQ mask
 *   0x1F801810 GP0, 0x1F801814 GP1, 0x1F801818 OTC-space GPUSTAT read
 *   0x1F8010C0+ ch2 (GPU) DMA, 0x1F8010E0+ ch6 (OTC) DMA, DPCR 0x1F8010F0
 *   0x1F801800+ CDROM regs (CdromUnit), 0x1F801C00+ SPU regs (SpuUnit),
 *   0x1F801820+ MDEC regs (MdecUnit) — wired as their modules land.
 */
import { Cpu } from "./cpu";
import { Memory } from "./memory";
import { Gpu, VRAM_W, VRAM_H } from "./gpu";
import { Rcnt } from "./rcnt";
import { GTE } from "./gte";
import { Dma } from "./dma";
import { hleSyscall } from "./syscall";
import { Cdrom } from "./cdrom";
import { Spu } from "./spu";
import { Mdec } from "./mdec";

export class Machine {
  readonly mem = new Memory();
  readonly gpu = new Gpu();
  readonly rcnt = new Rcnt();
  /** cop2 adapter: MFC2/MTC2 route GTE data regs (dr[r]) + control fallback. */
  readonly gte = {
    execute: (instr: number) => this.gteCore.execute(instr),
    mfc2: (r: number) => (r < 16 ? (this.gteCore.dr[r]! | 0) : (this.gteCore.cr[r - 16]! | 0)),
    mtc2: (r: number, v: number) => {
      if (r < 16) this.gteCore.dr[r] = v | 0;
      else this.gteCore.cr[r - 16] = v >>> 0;
    },
  };
  private readonly gteCore = new GTE();
  irqStatus = 0;
  irqMask = 0;
  readonly cpu: Cpu;
  /** 7-channel DMA controller (ch0 MDECin … ch6 OTC), DmaUnit delivery. */
  readonly dma = new Dma();
  /** CDROM controller (1F801800 + IRQ line 2). */
  readonly cdrom = new Cdrom();
  /** SPU (1F801C00+ u16 regs, IRQ line 9). */
  readonly spu = new Spu();
  /** CDROM controller (1F801800-1F801803 + IRQ line 2), CdromUnit delivery. */
  /** SPU (1F801C00+ u16 regs, IRQ line 9), SpuUnit delivery. */
  /** MDEC (1F801820+), MdecUnit delivery. */
  readonly mdec = new Mdec();

  constructor() {
    this.rcnt.irqFire = (line) => { this.raiseIrq(1 << line); };
    this.dma.raiseIrq = () => { this.raiseIrq(IRQ_DMA); };
    this.cdrom.irqFire = () => { this.raiseIrq(IRQ_CDROM); };
    this.spu.irqFire = () => { this.raiseIrq(IRQ_SPU); };
    this.cpu = new Cpu(this.mem, this.rcnt, this.gte, {
      read32: (va) => this.portRead(va),
      write32: (va, v) => this.portWrite(va, v),
    }, (table, fn) => hleSyscall(table, fn) ?? 0);
  }

  /** DmaBus adapter: DMA reads/writes RAM words and drives GP0. */
  private readonly dmaBus = {
    readRam: (a: number) => this.mem.load32(a & 0x1f_fffc),
    writeRam: (a: number, v: number) => this.mem.store32(a & 0x1f_fffc, v),
    gpuWrite: (w: number) => this.gpu.writeGP0(w),
    readVram: (addr: number) => this.gpu.vram[addr & (VRAM_W * VRAM_H - 1)]!,
    writeVram: (addr: number, v: number) => {
      this.gpu.vram[addr & (VRAM_W * VRAM_H - 1)] = v & 0x7fff;
    },
  };

  raiseIrq(bits: number): void {
    this.irqStatus |= bits;
  }

  private portRead(va: number): number | undefined {
    switch (va) {
      case 0x1f801070: return this.irqStatus | 0;
      case 0x1f801074: return this.irqMask | 0;
      case 0x1f801810: case 0x1f801814: return this.gpu.readGPUSTAT();
      default: {
        // DMA register window 0x1F801080-0x1F8010FF → DmaUnit regs.
        if (va >= 0x1f80_1080 && va <= 0x1f80_10f7) {
          if (va === 0x1f80_10f0) return this.dma.dpcr | 0;
          if (va === 0x1f80_10f4) return this.dma.dicr | 0;
          const ch = ((va - 0x1f80_1080) / 12) | 0;
          const off = va - 0x1f80_1080 - ch * 12;
          if (ch < 7 && off % 4 === 0 && off < 12) return this.dma.regs[ch * 3 + off / 4]! | 0;
        }
        // CDROM 0x1F801800-0x1F801803 (byte regs; 32-bit read = replicated).
        if (va >= 0x1f80_1800 && va <= 0x1f80_1803) {
          const b = this.cdrom.read(va - 0x1f80_1800);
          return (b | (b << 8) | (b << 16) | (b << 24)) >>> 0;
        }
        // SPU 0x1F801C00-0x1F801DFF (u16 regs; word read = lo|hi<<16).
        if (va >= 0x1f80_1c00 && va <= 0x1f80_1dff) {
          const off = (va - 0x1f80_1c00) >> 1;
          return (this.spu.regs[off]! | (this.spu.regs[off + 1]! << 16)) >>> 0;
        }
        // MDEC 0x1F801820-0x1F80182F (MDEC0 data read / MDEC1 status).
        if (va === 0x1f80_1820) { const out = this.mdec.readOutput(); return out.length ? out[0]! >>> 0 : 0; }
        if (va === 0x1f80_1824) return (this.mdec as unknown as { regs: number }).regs >>> 0;
        return undefined;
      }
    }
  }

  private portWrite(va: number, v: number): boolean {
    switch (va) {
      case 0x1f801070: this.irqStatus &= ~v; return true; // ack clears
      case 0x1f801074: this.irqMask = v >>> 0; return true;
      case 0x1f801810: this.gpu.writeGP0(v); return true;
      case 0x1f801814: this.gpu.writeGP1(v); return true;
      default: {
        if (va >= 0x1f80_1080 && va <= 0x1f80_10f7) {
          if (va === 0x1f80_10f0) { this.dma.dpcr = v >>> 0; return true; }
          if (va === 0x1f80_10f4) { this.dma.writeDicr(v >>> 0); return true; }
          const ch = ((va - 0x1f80_1080) / 12) | 0;
          const off = va - 0x1f80_1080 - ch * 12;
          if (ch < 7 && off % 4 === 0 && off < 12) {
            this.dma.regs[ch * 3 + off / 4] = v >>> 0;
            if (off === 8) this.dma.request(ch); // CHCR write triggers request
            return true;
          }
        }
        // CDROM byte regs 0x1F801800-0x1F801803.
        if (va >= 0x1f80_1800 && va <= 0x1f80_1803) {
          const off = va - 0x1f80_1800;
          if (off === 3) {
            // 1F801803: index-select bits 0-1 via port 0, ack via port 3
            // when current index is 1 (no$psx: INT acknowledge write).
            if ((this.cdrom.regs[0]! & 3) === 1) this.cdrom.ack(v & 0xff);
            this.cdrom.write(3, v & 0xff);
            return true;
          }
          this.cdrom.write(off, v & 0xff);
          return true;
        }
        // SPU u16 regs 0x1F801C00-0x1F801DFF.
        if (va >= 0x1f80_1c00 && va <= 0x1f80_1dff) {
          const off = (va - 0x1f80_1c00) >> 1;
          this.spu.regs[off] = v & 0xffff;
          return true;
        }
        // MDEC 0x1F801820 (data write) / 0x1F801824 (control).
        if (va === 0x1f80_1820) { this.mdec.write(v >>> 0); return true; }
        if (va === 0x1f80_1824) { this.mdec.writeControl(v >>> 0); return true; }
        return false;
      }
    }
  }

  /** Run DMA engines after each CPU slice (level-triggered, simple model). */
  private runDma(): void {
    this.dma.run(this.dmaBus);
  }

  private vblankAcc = 0;

  /** Run up to n CPU instructions with DMA/CDROM/SPU/rcnt service per slice. */
  runSlice(n: number): boolean {
    const ok = this.cpu.run(n);
    this.runDma();
    this.cdrom.exec(); // one interrupt-bucket per slice (timing: see cdrom.ts)
    this.spu.tick(n); // SPU clock = cpu cycles / 768 internally
    // VBLANK: ~60Hz — accumulate CPU cycles and raise IRQ line 0 each frame
    // (N = cycles/frame ≈ 33.8M/60 ≈ 563k at 33.8MHz CPU).
    this.vblankAcc += n;
    if (this.vblankAcc >= 563_000) { this.vblankAcc -= 563_000; this.raiseIrq(IRQ_VBLANK); }
    // rcnt ticks on the same clock; slice granularity is fine for Phase 1
    return ok;
  }

  loadExe(bytes: Uint8Array, pc0: number, tAddr: number, data: Uint8Array): void {
    this.mem.ram.set(data, tAddr);
    this.installHleVectors(); // BIOS-free boot: A/B/C call vectors
    this.cpu.reset(pc0);
    // crt0 register state the BIOS normally sets before _start.
    this.cpu.r[28] = 0x801f_ff00; // $gp
    this.cpu.r[29] = 0x801f_ff00; // $sp
    this.cpu.r[30] = 0x801f_ff00; // $fp
    this.cpu.r[31] = 0x8000_0068; // $ra → exit-loop stub
    this.cpu.r[5] = -1; // $r5 < 0: crt0's BLTZ preamble takes the save path
    this.mem.store32(0x100, 0x1000_0002); // beq $0,$0,+2 = spin
    this.mem.store32(0x104, 0); // delay-slot nop
    // crt0 leaves restore $ra from their stack frames; slots never written
    // read 0 → 'jr 0' crash. Fill the entire stack region (below $sp) with
    // the exit-loop address so any never-written slot returns to the
    // BIOS-equivalent spin instead.
    for (let a = 0x801f_e000; a < 0x801f_ff00; a += 4) {
      this.mem.store32(a, 0x8000_0100);
    }
  }

  /** Populate A(0xA0)/B(0xB0)/C(0xC0) trampolines: lui $t1,<table>; jr $ra. */
  installHleVectors(): void {
    // stub: syscall; jr $ra — the game sets $t1 (table: A=1/B=2/C=3, encoded
    // in bits 16-17 of the jump target) and $t1 low... the SYSCALL hits the
    // CPU's HLE fast path which dispatches on the table + fn.
    const stub = (): number[] => [
      0x0000_000c, // SYSCALL
      (0x08 << 26) | (31 << 21), // JR $ra
    ];
    for (const [va, table] of [[0xa0, 1], [0xb0, 2], [0xc0, 3]] as const) {
      const phys = va - 0x8000_0000;
      stub().forEach((w, i) => this.mem.store32(phys + 4 * i, w));
    }
  }

  /** load_bios spec (0x433540): fread(psxBIOS, 1, 0x80000) — 512 KiB max. */
  loadBios(dump: Uint8Array): void {
    if (dump.byteLength < 512 * 1024) throw new Error(`BIOS dump too small (${dump.byteLength} bytes, need 512 KiB)`);
    this.mem.bios.set(dump.subarray(0, 512 * 1024));
    this.cpu.reset(0xbfc0_0000); // BIOS entry
  }

  /** Full-state snapshot (zsave_snapshot_* spec): all typed-array state. */
  snapshot(): MachineSnapshot {
    const g = this.gteCore;
    return {
      ram: this.mem.ram.slice(),
      parallel: this.mem.parallel.slice(),
      scratchpad: this.mem.scratchpad.slice(),
      bios: this.mem.bios.slice(),
      vram: this.gpu.vram.slice(),
      cpu: {
        r: [...this.cpu.r], hi: this.cpu.hi, lo: this.cpu.lo,
        pc: this.cpu.pc, nextPc: this.cpu.nextPc,
        cp0: [...this.cpu.cp0], cycles: this.cpu.cycles,
        loadDelay: { ...this.cpu.loadDelay },
        inBranchDelay: this.cpu.inBranchDelay,
      },
      gte: {
        v: g.v.slice(), dr: g.dr.slice(), cr: g.cr.slice(),
      },
      rcnt: this.rcnt.regs.slice(),
      irqStatus: this.irqStatus, irqMask: this.irqMask,
    };
  }

  restore(s: MachineSnapshot): void {
    this.mem.ram.set(s.ram);
    this.mem.parallel.set(s.parallel);
    this.mem.scratchpad.set(s.scratchpad);
    this.mem.bios.set(s.bios);
    this.gpu.vram.set(s.vram);
    this.cpu.r.set(s.cpu.r);
    this.cpu.hi = s.cpu.hi; this.cpu.lo = s.cpu.lo;
    this.cpu.pc = s.cpu.pc; this.cpu.nextPc = s.cpu.nextPc;
    this.cpu.cp0.set(s.cpu.cp0);
    this.cpu.cycles = s.cpu.cycles;
    this.cpu.loadDelay = { ...s.cpu.loadDelay };
    this.cpu.inBranchDelay = s.cpu.inBranchDelay;
    this.gteCore.v.set(s.gte.v);
    this.gteCore.dr.set(s.gte.dr);
    this.gteCore.cr.set(s.gte.cr);
    this.rcnt.regs.set(s.rcnt);
    this.irqStatus = s.irqStatus;
    this.irqMask = s.irqMask;
  }
}

export interface MachineSnapshot {
  ram: Uint8Array; parallel: Uint8Array; scratchpad: Uint8Array; bios: Uint8Array;
  vram: Uint16Array;
  cpu: {
    r: number[]; hi: number; lo: number; pc: number; nextPc: number;
    cp0: number[]; cycles: number;
    loadDelay: { slot: number; reg: number; value: number };
    inBranchDelay: boolean;
  };
  gte: { v: Int16Array; dr: Int32Array; cr: Uint32Array };
  rcnt: Uint16Array;
  irqStatus: number; irqMask: number;
}
