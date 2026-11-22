/**
 * Root counters (rcnt_update spec): 3 timers, sysclk/pixel/hblank gates,
 * IRQ on target/reach-FFFF. Phase 1 minimal but spec-shaped.
 */
export class Rcnt {
  /** [timer][value,mode,target] as raw registers, mirrors ePSXe layout. */
  readonly regs = new Uint16Array(9);
  private hblank = 0;
  irqFire: (line: number) => void = () => {};

  reset(): void { this.regs.fill(0); this.hblank = 0; }

  /** Advance by CPU cycles; called per slice from the frame loop. */
  tick(cycles: number): void {
    for (let t = 0; t < 3; t++) {
      const mode = this.regs[t * 3 + 1]!;
      const target = this.regs[t * 3 + 2]!;
      const gate = (mode >>> 8) & 3;
      let step = 1;
      if (t === 1 && gate !== 0) step = gate === 1 ? 0 : 1; // hblank gating t1
      if (t === 2 && gate !== 0) step = 1;
      let v = this.regs[t * 3]!;
      let done = false;
      for (let i = 0; i < cycles && !done; i += step) {
        v = (v + 1) & 0xffff;
        if (v === target && target !== 0 && (mode & 0x100)) {
          this.irqFire(3 + t); // IRQ lines 3,4,5
          this.regs[t * 3 + 1] = (mode & 0xffff) | 0x400; // target reached flag
          if (mode & 0x1000) {
            v = 0; // zero-return: wrap and keep counting this slice
          } else {
            done = true; // stop-at-target: freeze until next sync
          }
        }
      }
      this.regs[t * 3] = v;
    }
  }
}
