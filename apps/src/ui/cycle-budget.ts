const CPU_CYCLES_PER_MS = 33_868.8;
const SLICE_CYCLES = 20_000;
const MAX_ELAPSED_MS = 100;
const MAX_BUDGET_CYCLES = 3_386_880;

/** Bounded console-cycle accumulator; presentation refresh does not set game speed. */
export class CycleBudget {
  private remaining = 0;

  advance(elapsedMs: number): number {
    const elapsed = Math.min(MAX_ELAPSED_MS, Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0));
    this.remaining = Math.min(this.remaining + elapsed * CPU_CYCLES_PER_MS, MAX_BUDGET_CYCLES);
    let slices = 0;
    while (this.remaining >= SLICE_CYCLES) {
      this.remaining -= SLICE_CYCLES;
      slices++;
    }
    return slices;
  }
}
