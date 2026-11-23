/**
 * MIPS R3000A interpreter — the run_interpreter/BranchDelay contract from
 * the RE map: 32 GPRs (+r0 hardwired 0), hi/lo, PC, CP0, load-delay slot,
 * branch-delay slot, all in flat typed arrays (no object allocation per step).
 *
 * Phase 1 covers the full user-space ISA (opcodes R_* in the binary map):
 * SPECIAL/REGIMM/J/JAL/BEQ/BNE/BLEZ/BGTZ, ADDI/ADDIU/SLTI/SLTIU/ANDI/ORI/XORI/
 * LUI, COP0 (MFC0/MTC0/RFE), COP2 dispatch, LB/LH/LWL/LW/LBU/LHU/LWR/SB/SH/
 * SWL/SW/SWR, LL/SC (uniprocessor: always succeed), SPECIAL2 MUL.
 * LWC2/SWC2 route to the GTE.
 */
import { Memory, translate } from "./memory";
import { Rcnt } from "./rcnt";

export const EXC_LOAD = 0x4, EXC_STORE = 0x5, EXC_SYS = 0x8, EXC_BP = 0x9, EXC_OV = 0xc;

export class Cpu {
  readonly r = new Int32Array(32);
  hi = 0; lo = 0;
  pc = 0xbfc0_0000;
  nextPc = 0xbfc0_0004;
  readonly cp0 = new Uint32Array(16);
  inBranchDelay = false;
  loadDelay = { slot: 0, reg: 0, value: 0 }; // one pending load, PS1 has 1 slot
  cycles = 0;

  constructor(
    readonly mem: Memory,
    readonly rcnt: Rcnt,
    readonly gte: { execute(instr: number): void; mfc2(r: number): number; mtc2(r: number, v: number): void },
    /** MMIO port hooks: port address → value or undefined to fall through. */
    readonly ports: {
      read32(va: number): number | undefined;
      write32(va: number, v: number, width: number): boolean;
    },
    readonly hleSyscall?: (table: number, fn: number) => number,
  ) {}

  reset(entry = 0xbfc0_0000): void {
    this.r.fill(0);
    this.cp0.fill(0);
    this.hi = this.lo = 0;
    this.pc = entry;
    this.nextPc = (entry + 4) | 0;
    this.inBranchDelay = false;
    this.loadDelay.slot = 0;
    this.cycles = 0;
  }

  /** Execute n instructions. Returns false on unhandled exception. */
  run(n: number): boolean {
    for (let i = 0; i < n; i++) {
      if (!this.step()) return false;
    }
    return true;
  }

  step(): boolean {
    // Load-delay: value from the *previous* instruction lands this cycle.
    if (this.loadDelay.slot) {
      const { reg, value } = this.loadDelay;
      if (reg !== 0) this.r[reg] = value;
      this.loadDelay.slot = 0;
    }

    const pc = this.pc >>> 0;
    const vector = pc & 0x1fff_ffff;
    const isVector = vector === 0xa0 || vector === 0xb0 || vector === 0xc0;
    const isHleRam = pc >= 0x8000_0100 && pc < 0x8000_3000;
    if (pc >= 0x8080_0000 && pc < 0xa000_0000 && !isVector && !isHleRam) return false;
    if ((translate(this.pc).region as number) < 0) return false; // unmapped instruction address
    const instr = this.mem.load32(this.pc) | 0;
    const curPc = this.pc; // link/branch base BEFORE advancing
    this.pc = this.nextPc;
    this.nextPc = (this.pc + 4) | 0;
    this.cycles++;

    const op = instr >>> 26;
    const rs = (instr >>> 21) & 31, rt = (instr >>> 16) & 31, rd = (instr >>> 11) & 31;
    const sa = (instr >>> 6) & 31;
    const fn = instr & 63;
    const imm = instr & 0xffff, simm = (imm << 16) >> 16;
    const r = this.r;

    switch (op) {
      case 0x00: // SPECIAL
        switch (fn) {
          case 0x00: if (rd) r[rd] = (r[rt]! << sa) | 0; break; // SLL (also NOP)
          case 0x02: if (rd) r[rd] = r[rt]! >>> sa; break; // SRL
          case 0x03: if (rd) r[rd] = r[rt]! >> sa; break; // SRA
          case 0x04: if (rd) r[rd] = r[rt]! << (r[rs]! & 31); break; // SLLV
          case 0x06: if (rd) r[rd] = r[rt]! >>> (r[rs]! & 31); break; // SRLV
          case 0x07: if (rd) r[rd] = r[rt]! >> (r[rs]! & 31); break; // SRAV
          case 0x08: this.nextPc = r[rs]!; break; // JR — delay slot runs, then pc = r[rs]
          case 0x09: { // JALR — link = instr addr + 8 (past delay slot)
            const t = (curPc + 8) | 0;
            this.nextPc = r[rs]!; // delay slot at this.pc executes first
            if (rd) r[rd] = t;
            break;
          }
          case 0x0c: { // SYSCALL
            const table = curPc & 0x1fff_ffff;
            if (this.hleSyscall && (table === 0xa0 || table === 0xb0 || table === 0xc0)) {
              // PSX kernel ABI: vector PC selects A/B/C; R9 ($t1) is the function.
              const fn = r[9]!;
              const ret = this.hleSyscall(table, fn) ?? 0;
              r[2] = ret | 0; // $v0
              this.pc = r[31]!; // return to caller (stub already did jr ra)
              this.nextPc = (r[31]! + 4) | 0;
              return true;
            }
            if (r[4] === 1 || r[4] === 2) {
              const sr = this.cp0[12]!;
              if (r[4] === 2) {
                this.cp0[12] = (sr | 0x405) >>> 0; // ExitCriticalSection: IEc, bit2, IRQ mask
              } else {
                r[2] = (sr & 0x404) === 0x404 ? 1 : 0;
                this.cp0[12] = ((sr & ~0x404) | ((sr >>> 2) & 1)) >>> 0;
              }
              return true;
            }
            this.exception(EXC_SYS, 0); return true;
          }
          case 0x0d: this.exception(EXC_BP, 0); return true; // BREAK
          case 0x10: { // MFHI
            if (rd) r[rd] = this.hi; break;
          }
          case 0x11: this.hi = r[rs]!; break; // MTHI
          case 0x12: if (rd) r[rd] = this.lo; break; // MFLO
          case 0x13: this.lo = r[rs]!; break; // MTLO
          case 0x18: { // MULT — exact signed 64-bit product via unsigned limbs
            const a = r[rs]!, b = r[rt]!;
            const aLo = a & 0xffff, aHi = a >>> 16, bLo = b & 0xffff, bHi = b >>> 16;
            const ll = Math.imul(aLo, bLo);
            const lh = Math.imul(aLo, bHi), hl = Math.imul(aHi, bLo);
            const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
            this.lo = ((mid << 16) | (ll & 0xffff)) | 0;
            this.hi = (Math.imul(aHi, bHi) + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) | 0;
            break;
          }
          case 0x19: { // MULTU
            const a = r[rs]! >>> 0, b = r[rt]! >>> 0;
            const p = a * b;
            this.lo = p | 0;
            this.hi = (p / 2 ** 32) | 0;
            break;
          }
          case 0x1a: { // DIV — MIPS: quotient truncates toward zero
            const a = r[rs]!, b = r[rt]!;
            if (b !== 0) {
              this.lo = (a / b) | 0;
              this.hi = (a % b) | 0;
            }
            break;
          }
          case 0x1b: { // DIVU
            const a = r[rs]! >>> 0, b = r[rt]! >>> 0;
            if (b !== 0) {
              this.lo = (a / b) | 0;
              this.hi = (a % b) | 0;
            }
            break;
          }
          case 0x20: if (rd) r[rd] = this.add(r[rs]!, r[rt]!, true); break; // ADD
          case 0x21: if (rd) r[rd] = (r[rs]! + r[rt]!) | 0; break; // ADDU
          case 0x22: if (rd) r[rd] = this.sub(r[rs]!, r[rt]!, true); break; // SUB
          case 0x23: if (rd) r[rd] = (r[rs]! - r[rt]!) | 0; break; // SUBU
          case 0x24: if (rd) r[rd] = r[rs]! & r[rt]!; break; // AND
          case 0x25: if (rd) r[rd] = r[rs]! | r[rt]!; break; // OR
          case 0x26: if (rd) r[rd] = r[rs]! ^ r[rt]!; break; // XOR
          case 0x27: if (rd) r[rd] = ~(r[rs]! | r[rt]!) | 0; break; // NOR
          case 0x2a: if (rd) r[rd] = r[rs]! < r[rt]! ? 1 : 0; break; // SLT
          case 0x2b: if (rd) r[rd] = (r[rs]! >>> 0) < (r[rt]! >>> 0) ? 1 : 0; break; // SLTU
          default: return false; // unknown SPECIAL = stop (verifier will flag)
        }
        return true;

      case 0x01: // REGIMM
        switch (rt) {
          case 0x00: if (r[rs]! < 0) this.branch(simm); break; // BLTZ
          case 0x01: if (r[rs]! >= 0) this.branch(simm); break; // BGEZ
          case 0x10: r[31] = (curPc + 8) | 0; if (r[rs]! < 0) this.branch(simm); break; // BLTZAL (links always)
          case 0x11: r[31] = (curPc + 8) | 0; if (r[rs]! >= 0) this.branch(simm); break; // BGEZAL (links always)
          default: console.log('[cpu] unknown SPECIAL2 sub at pc=0x'+(this.pc>>>0).toString(16)); return false;
        }
        return true;

      case 0x02: this.jump(instr & 0x03ff_ffff); return true; // J
      case 0x03: r[31] = (curPc + 8) | 0; this.jump(instr & 0x03ff_ffff); return true; // JAL
      case 0x04: if (r[rs]! === r[rt]!) this.branch(simm); return true; // BEQ
      case 0x05: if (r[rs]! !== r[rt]!) this.branch(simm); return true; // BNE
      case 0x06: if (r[rs]! <= 0) this.branch(simm); return true; // BLEZ
      case 0x07: if (r[rs]! > 0) this.branch(simm); return true; // BGTZ
      case 0x08: if (rt) r[rt] = this.add(r[rs]!, simm, true); return true; // ADDI
      case 0x09: if (rt) r[rt] = (r[rs]! + simm) | 0; return true; // ADDIU
      case 0x0a: if (rt) r[rt] = r[rs]! < simm ? 1 : 0; return true; // SLTI
      case 0x0b: if (rt) r[rt] = (r[rs]! >>> 0) < (simm >>> 0) ? 1 : 0; return true; // SLTIU
      case 0x0c: if (rt) r[rt] = r[rs]! & imm; return true; // ANDI
      case 0x0d: if (rt) r[rt] = r[rs]! | imm; return true; // ORI
      case 0x0e: if (rt) r[rt] = r[rs]! ^ imm; return true; // XORI
      case 0x0f: if (rt) r[rt] = imm << 16; return true; // LUI

      case 0x10: // COP0
        switch (rs) {
          case 0x00: if (rt) r[rt] = this.cp0[rd]! | 0; break; // MFC0
          case 0x04: this.cp0[rd] = r[rt]! >>> 0; break; // MTC0
          case 0x10: // RFE — restore exception SR: bits 3:2 → 1:0, clear 5:2
            if (fn === 0x10) {
              const sr = this.cp0[12]!;
              this.cp0[12] = ((sr & ~0x3f) | ((sr >>> 2) & 0x3)) >>> 0;
            }
            break;
          default: console.log('[cpu] unknown SPECIAL2 sub at pc=0x'+(this.pc>>>0).toString(16)); return false;
        }
        return true;

      case 0x11: // COP1: absent on PS1 — treated as NOP
        return true;

      case 0x12: // COP2 (GTE)
        if ((instr & (1 << 25)) === 0) {
          switch (rs) {
            case 0x00: if (rt) r[rt] = this.gte.mfc2(rt); break; // MFC2
            case 0x04: case 0x06: this.gte.mtc2(rt, r[rt]!); break; // MTC2 (cts 2/6 both write)
            default: return false;
          }
        } else {
          this.gte.execute(instr);
        }
        return true;

      case 0x13: return true; // COP3: not present

      case 0x20: return this.load(rt, this.addr(rs, simm), 8, false); // LB
      case 0x21: return this.load(rt, this.addr(rs, simm), 16, false); // LH
      case 0x22: { // LWL — R_LWL @0x43ab20 byte-exact (n=addr&3, W=aligned)
        const a = this.addr(rs, simm);
        const n = a & 3, w = this.mem.load32(a & ~3);
        if (rt) {
          if (n === 0) r[rt] = (r[rt]! & 0x00ff_ffff) | ((w & 0xff) << 24);
          else if (n === 1) r[rt] = ((w << 16) | (r[rt]! & 0x0000_ffff)) | 0;
          else if (n === 2) r[rt] = (w << 8) | (r[rt]! & 0xff);
          else r[rt] = w;
        }
        break;
      }
      case 0x23: return this.load(rt, this.addr(rs, simm), 32, false); // LW
      case 0x24: return this.load(rt, this.addr(rs, simm), 8, true); // LBU
      case 0x25: return this.load(rt, this.addr(rs, simm), 16, true); // LHU
      case 0x26: { // LWR — R_LWR @0x43ac00 byte-exact
        const a = this.addr(rs, simm);
        const n = a & 3, w = this.mem.load32(a & ~3);
        if (rt) {
          if (n === 0) r[rt] = w;
          else if (n === 1) r[rt] = (r[rt]! & 0xff00_0000) | (w >>> 8);
          else if (n === 2) r[rt] = (r[rt]! & 0xffff_0000) | ((w >>> 16) & 0xffff);
          else r[rt] = (r[rt]! & 0xffff_ff00) | ((w >>> 24) & 0xff);
        }
        break;
      }
      case 0x28: return this.store(rt, this.addr(rs, simm), 8); // SB
      case 0x29: return this.store(rt, this.addr(rs, simm), 16); // SH
      case 0x2b: return this.store(rt, this.addr(rs, simm), 32); // SW
      case 0x2a: { // SWL — R_SWL @0x43aec0 byte-exact
        const a = this.addr(rs, simm);
        const n = a & 3, old = this.mem.load32(a & ~3), v = r[rt]!;
        if (n === 0) this.mem.store32(a & ~3, (old & 0xffff_ff00) | ((v >>> 24) & 0xff));
        else if (n === 1) this.mem.store32(a & ~3, (old & 0xffff_0000) | (v >>> 16));
        else if (n === 2) this.mem.store32(a & ~3, (old & 0xff00_0000) | (v >>> 8));
        else this.mem.store32(a & ~3, v);
        break;
      }
      case 0x2e: { // SWR — R_SWR @0x43afc0 byte-exact
        const a = this.addr(rs, simm);
        const n = a & 3, old = this.mem.load32(a & ~3), v = r[rt]!;
        if (n === 0) this.mem.store32(a & ~3, v);
        else if (n === 1) this.mem.store32(a & ~3, (old & 0xff) | (v << 8));
        else if (n === 2) this.mem.store32(a & ~3, (old & 0xffff) | (v << 16));
        else this.mem.store32(a & ~3, (old & 0x00ff_ffff) | (v << 24));
        break;
      }
      case 0x27: return true; // CACHE — R3000A: no-op (PS1 has no cache ctrl)
      case 0x30: return this.load(rt, this.addr(rs, simm), 32, false, true); // LL
      case 0x31: return this.load(rt, this.addr(rs, simm), 16, false); // LWC1 skipped: not present
      case 0x32: { // LWC2 → GTE data reg
        const a = this.addr(rs, simm);
        this.gte.mtc2(rt & 15, this.mem.load32(a));
        return true;
      }
      case 0x38: return this.store(rt, this.addr(rs, simm), 32); // SC (unip: rt=1)
      case 0x3a: { // SWC2 → GTE data reg
        const a = this.addr(rs, simm);
        this.mem.store32(a, this.gte.mfc2(rt & 15));
        return true;
      }

            default: return false; // unknown major opcode
    }
    return true;
  }

  private addr(rs: number, simm: number): number {
    return (this.r[rs]! + simm) | 0;
  }

  private load(rt: number, va: number, width: number, unsigned: boolean, ll = false): boolean {
    // Unaligned LW/LH: real HW raises AdEL; the BIOS handler emulates the
    // access byte-wise and returns — we do the same inline so the game keeps
    // running (the exception path would NOP-slide forever with no BIOS).
    if (width !== 8 && (va & (width / 8 - 1)) !== 0) {
      let v = 0;
      for (let k = 0; k < width / 8; k++) v |= this.mem.load8(va + k) << (8 * k);
      const sv = width === 16 && !unsigned ? (v << 16) >> 16 : v | 0;
      if (this.loadDelay.slot) {
        const { reg } = this.loadDelay;
        if (reg !== 0) this.r[reg] = this.loadDelay.value;
      }
      this.loadDelay = rt === 0 ? { slot: 0, reg: 0, value: 0 } : { slot: 1, reg: rt, value: sv };
      return true;
    }
    const mmio = va >= 0x1f80_1000 && va <= 0x1f80_1fff ? this.ports.read32(va) : undefined;
    let raw: number;
    if (mmio !== undefined) raw = mmio;
    else if (width === 8) raw = this.mem.load8(va);
    else if (width === 16) raw = this.mem.load8(va) | (this.mem.load8(va + 1) << 8);
    else raw = this.mem.load32(va);
    const v = width === 8
      ? (unsigned ? raw & 0xff : (raw << 24) >> 24)
      : width === 16
        ? (unsigned ? raw & 0xffff : (raw << 16) >> 16)
        : raw | 0;
    // Load-delay: land in the NEXT cycle. One slot, overwrite semantics.
    if (this.loadDelay.slot) {
      const { reg } = this.loadDelay;
      if (reg !== 0) this.r[reg] = this.loadDelay.value;
    }
    this.loadDelay = { slot: 1, reg: rt, value: v };
    if (rt === 0) this.loadDelay.slot = 0; // r0 loads: no-op
    return true;
  }

  private store(rt: number, va: number, width: number): boolean {
    if (width !== 8 && (va & (width / 8 - 1)) !== 0) {
      // BIOS handler emulates the unaligned store byte-wise.
      const v = this.r[rt]!;
      if (width === 16) {
        this.mem.store8(va, v & 0xff);
        this.mem.store8(va + 1, (v >>> 8) & 0xff);
      } else {
        for (let k = 0; k < 4; k++) this.mem.store8(va + k, (v >>> (8 * k)) & 0xff);
      }
      return true;
    }
    const v = this.r[rt]!;
    // MMIO ports first: preserve the CPU access width for byte/halfword registers.
    if (va >= 0x1f80_1000 && va <= 0x1f80_1fff && this.ports.write32(va, v, width)) return true;
    if (width === 32) {
      this.mem.store32(va, v);
      return true;
    }
    if (width === 8) this.mem.store8(va, v);
    else {
      this.mem.store8(va, v & 0xff);
      this.mem.store8(va + 1, (v >>> 8) & 0xff);
    }
    return true;
  }

  private branch(off: number): void {
    this.nextPc = (this.pc + (off << 2)) | 0;
    this.inBranchDelay = true;
  }

  private jump(imm: number): void {
    this.nextPc = ((this.pc & 0xf000_0000) | (imm << 2)) | 0;
    this.inBranchDelay = true;
  }

  private add(a: number, b: number, trap: boolean): number {
    const res = (a + b) | 0;
    if (trap) {
      const ov = ((~(a ^ b)) & (a ^ res)) < 0;
      if (ov) { this.exception(EXC_OV, 0); }
    }
    return res;
  }

  private sub(a: number, b: number, trap: boolean): number {
    const res = (a - b) | 0;
    if (trap) {
      const ov = (((a ^ b)) & (a ^ res)) < 0;
      if (ov) { this.exception(EXC_OV, 0); }
    }
    return res;
  }

  /**
   * Exception. BIOS-free boot: there is no BIOS handler at 0x80000080 (it
   * NOP-slides into garbage), so we emulate the BIOS's default outcome —
   * return to EPC+4, skipping the faulting instruction — instead of jumping
   * to the vector. Full CP0 exception delivery is a Phase-3+ ticket.
   */
  exception(code: number, _info: number): void {
    const sr = this.cp0[12]!;
    this.cp0[13] = ((code << 2) | (_info & 0xff00) | (this.inBranchDelay ? (1 << 31) : 0)) >>> 0; // CAUSE
    this.cp0[12] = ((sr & ~0xf) | ((sr << 2) & 0x3f)) >>> 0;
    // If a handler exists at the vector, deliver the exception; otherwise
    // emulate the BIOS default outcome: return past the faulting instruction.
    const epc = (this.pc - (this.inBranchDelay ? 4 : 0)) >>> 0;
    this.cp0[14] = epc;
    if (this.mem.load32(0x8000_0080) !== 0) {
      this.pc = 0x8000_0080;
      this.nextPc = 0x8000_0084;
      this.inBranchDelay = false;
    } else {
      this.pc = (epc + 4) | 0;
      this.nextPc = (this.pc + 4) | 0;
      this.inBranchDelay = false;
    }
  }
}
