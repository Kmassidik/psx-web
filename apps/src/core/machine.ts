/**
 * Machine = Memory + CPU + Gpu + Rcnt + minimal DMA/IRQ wired as MMIO ports.
 * Port map (per PS1 doc + binary's CdromIoIrqFunc* family layout):
 *   0x1F801070 IRQ status, 0x1F801074 IRQ mask
 *   0x1F801810 GP0, 0x1F801814 GP1, 0x1F801818 OTC-space GPUSTAT read
 *   0x1F8010C0+ ch2 (GPU) DMA, 0x1F8010E0+ ch6 (OTC) DMA, DPCR 0x1F8010F0
 */
import { Cpu } from "./cpu";
import { Memory } from "./memory";
import { Gpu } from "./gpu";
import { Rcnt } from "./rcnt";

export class Machine {
  readonly mem = new Memory();
  readonly gpu = new Gpu();
  readonly rcnt = new Rcnt();
  irqStatus = 0;
  irqMask = 0;
  readonly cpu: Cpu;

  // DMA ch2 (GPU)
  private ch2Base = 0; private ch2Block = 0; private ch2Ctrl = 0;
  private ch2Running = false;
  // DMA ch6 (OTC)
  private ch6Base = 0; private ch6Block = 0; private ch6Ctrl = 0; private ch6Running = false;

  constructor() {
    // Minimal GTE stand-in until the real unit lands (Phase 1 proper):
    const gteStub = {
      execute: (_instr: number) => {},
      mfc2: (_r: number) => 0,
      mtc2: (_r: number, _v: number) => {},
    };
    this.rcnt.irqFire = (line) => { this.raiseIrq(1 << line); };
    this.cpu = new Cpu(this.mem, this.rcnt, gteStub, {
      read32: (va) => this.portRead(va),
      write32: (va, v) => this.portWrite(va, v),
    });
  }

  raiseIrq(bits: number): void {
    this.irqStatus |= bits;
  }

  private portRead(va: number): number | undefined {
    switch (va) {
      case 0x1f801070: return this.irqStatus | 0;
      case 0x1f801074: return this.irqMask | 0;
      case 0x1f801810: return this.gpu.readGPUSTAT();
      case 0x1f801814: return this.gpu.readGPUSTAT();
      case 0x1f8010c4: return this.ch2Block; case 0x1f8010c8: return this.ch2Ctrl;
      case 0x1f8010e4: return this.ch6Block; case 0x1f8010e8: return this.ch6Ctrl;
      default: return undefined;
    }
  }

  private portWrite(va: number, v: number): boolean {
    switch (va) {
      case 0x1f801070: this.irqStatus &= ~v; return true; // ack clears
      case 0x1f801074: this.irqMask = v >>> 0; return true;
      case 0x1f801810: this.gpu.writeGP0(v); return true;
      case 0x1f801814: this.gpu.writeGP1(v); return true;
      case 0x1f8010c0: this.ch2Base = v >>> 0; return true;
      case 0x1f8010c4: this.ch2Block = v >>> 0; return true;
      case 0x1f8010c8:
        this.ch2Ctrl = v >>> 0;
        if ((v & 0x0100_0000) && (v & 0x0200_0000) === 0) this.ch2Running = true;
        return true;
      case 0x1f8010e0: this.ch6Base = v >>> 0; return true;
      case 0x1f8010e4: this.ch6Block = v >>> 0; return true;
      case 0x1f8010e8:
        this.ch6Ctrl = v >>> 0;
        if ((v & 0x0100_0000) && (v & 0x0200_0000) === 0) this.ch6Running = true;
        return true;
      default: return false;
    }
  }

  /** Run DMA engines after each CPU slice (level-triggered, simple model). */
  private runDma(): void {
    if (this.ch6Running) { // OTC: build reverse clear-texture table, per spec
      let addr = this.ch6Base & 0x1f_fffc;
      const n = (this.ch6Block & 0xffff) || 1;
      for (let i = 0; i < n; i++) {
        const next = i === n - 1 ? 0x00ff_ffff : ((addr - 4) & 0x1f_fffc);
        this.mem.store32(addr, next);
        addr = (addr - 4) & 0x1f_fffc;
      }
      this.ch6Running = false;
      this.ch6Ctrl &= ~0x0100_0000;
      this.raiseIrq(1 << 24 >> 24); // DMA irq bit 3 (channel 6) — see map below
      this.irqStatus |= 8; // line 3 = DMA
    }
    if (this.ch2Running) { // GPU linked-list
      let addr = this.ch2Base & 0x1f_fffc;
      for (let guard = 0; guard < 1 << 20; guard++) {
        const head = this.mem.load32(addr);
        const words = (head >>> 24) & 0xff;
        if (words === 0) break;
        for (let i = 0; i < words; i++) {
          addr = (addr + 4) & 0x1f_fffc;
          this.gpu.writeGP0(this.mem.load32(addr));
        }
        addr = head & 0x1f_fffc;
        if (addr === 0x00ff_ffff) break;
      }
      this.ch2Running = false;
      this.ch2Ctrl &= ~0x0100_0000;
      this.irqStatus |= 8;
    }
  }

  /** Run up to n CPU instructions with DMA/rcnt service per slice. */
  runSlice(n: number): boolean {
    const ok = this.cpu.run(n);
    this.runDma();
    // rcnt ticks on the same clock; slice granularity is fine for Phase 1
    return ok;
  }

  loadExe(bytes: Uint8Array, pc0: number, tAddr: number, data: Uint8Array): void {
    this.mem.ram.set(data, tAddr);
    this.cpu.reset(pc0);
  }
}
