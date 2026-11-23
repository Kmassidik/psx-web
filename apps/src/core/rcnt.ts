/**
 * Root counters (rcnt_update spec): 3 timers, sysclk/pixel/hblank gates,
 * IRQ on target/reach-FFFF. Phase 1 minimal but spec-shaped.
 */
export class Rcnt {
  /** [timer][value,mode,target] as raw registers, mirrors ePSXe layout. */
  readonly regs = new Uint16Array(9);
  private hblank = 0;
  private irqFired = 0;
  irqFire: (line: number) => void = () => {};

  reset(): void { this.regs.fill(0); this.hblank = 0; this.irqFired = 0; }
  rearmIrq(timer: number): void { this.irqFired &= ~(1 << timer); }

  private fire(timer: number, mode: number): void {
    if ((mode & 0x40) === 0 && (this.irqFired & (1 << timer)) !== 0) return;
    this.irqFired |= 1 << timer;
    this.irqFire(4 + timer);
  }

  /** Advance by CPU cycles; called per slice from the frame loop. */
  tick(cycles: number): void {
    for (let t = 0; t < 3; t++) {
      const mode = this.regs[t * 3 + 1]!;
      const target = this.regs[t * 3 + 2]!;
      const sync = mode & 7;
      if (t === 2 && (sync === 0 || sync === 3)) continue; // synchronized counter 2 is stopped
      const source = (mode >>> 8) & 3;
      const step = t === 2 && source >= 2 ? 8 : 1;
      const resetOnTarget = (mode & 0x08) !== 0;
      const irqOnTarget = (mode & 0x10) !== 0;
      const irqOnOverflow = (mode & 0x20) !== 0;
      let value = this.regs[t * 3]!;
      for (let i = 0; i < cycles; i += step) {
        value = (value + 1) & 0xffff;
        if (value === target && target !== 0) {
          this.regs[t * 3 + 1] = this.regs[t * 3 + 1]! | 0x0800;
          if (irqOnTarget) this.fire(t, mode);
          if (resetOnTarget) value = 0;
        }
        if (value === 0xffff) {
          this.regs[t * 3 + 1] = this.regs[t * 3 + 1]! | 0x1000;
          if (irqOnOverflow) this.fire(t, mode);
        }
      }
      this.regs[t * 3] = value;
    }
  }
}
