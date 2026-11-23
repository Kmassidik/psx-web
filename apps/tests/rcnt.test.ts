import { describe, test, expect } from "bun:test";
import { Rcnt } from "../src/core/rcnt";

describe("Root counters (rcnt_update contract)", () => {
  test("timer 0 sysclk increments and wraps at FFFF", () => {
    const r = new Rcnt();
    r.regs[0] = 0xfffe;
    r.regs[1] = 0; // no target IRQ
    r.tick(5);
    expect(r.regs[0]).toBe(3); // (0xfffe+5) & 0xffff
  });

  test("target IRQ fires when value reaches target and mode bit8 set", () => {
    const r = new Rcnt();
    let fired = 0;
    r.irqFire = () => fired++;
    r.regs[1] = 0x0100; // IRQ at target
    r.regs[2] = 10; // target
    r.tick(10);
    expect(fired).toBe(1);
    expect(r.regs[1]! & 0x0400).not.toBe(0); // reached-target flag
    expect(r.regs[0]).toBe(10);
  });

  test("zero-return mode resets counter after target", () => {
    const r = new Rcnt();
    r.irqFire = () => {};
    r.regs[1] = 0x0100 | 0x1000; // IRQ on target + zero-return
    r.regs[2] = 5;
    r.tick(7);
    expect(r.regs[0]).toBe(2); // 7-5 wrapped
  });

  test("timer 1 HBlank gate advances without a zero-step infinite loop", () => {
    const r = new Rcnt();
    r.regs[3] = 10;
    r.regs[4] = 0x0100; // gate mode 1
    r.tick(20_000);
    expect(r.regs[3]).toBe(20_010);
  });

  test("no IRQ without mode bit8 even past target", () => {
    const r = new Rcnt();
    let fired = 0;
    r.irqFire = () => fired++;
    r.regs[2] = 3;
    r.tick(10);
    expect(fired).toBe(0);
  });
});
