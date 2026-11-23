import { describe, expect, test } from "bun:test";
import { CycleBudget } from "../src/ui/cycle-budget";

describe("console cycle pacing", () => {
  test("60 Hz and 120 Hz receive proportional console-rate slices", () => {
    const at60 = new CycleBudget();
    const at120 = new CycleBudget();
    expect(at60.advance(1000 / 60)).toBe(28);
    expect(at120.advance(1000 / 120)).toBe(14);
    expect(at60.advance(1000 / 60)).toBe(28);
    expect(at120.advance(1000 / 120)).toBe(14);
  });

  test("catch-up is bounded and invalid elapsed values do not execute cycles", () => {
    const budget = new CycleBudget();
    expect(budget.advance(-10)).toBe(0);
    expect(budget.advance(Number.NaN)).toBe(0);
    expect(budget.advance(5_000)).toBe(169); // capped at 100 ms / 20k slices
    expect(budget.advance(0)).toBe(0);
  });
});
