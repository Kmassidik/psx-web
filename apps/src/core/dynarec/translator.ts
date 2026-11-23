/**
 * MIPS → WebAssembly block translator — the wasm tier mirroring
 * c_recompile_code: one basic block (straight-line run ending at a
 * branch/jump incl. its delay slot, or a SW that may alias code, or the
 * 64-instruction cap) compiles to a WASM function `run()` operating through
 * the imported linear memory.
 *
 * Emitted module (binary layout in emitter.ts; opcodes hex-documented there):
 *   types:   0: ()→(), 1: (i32)→i32, 2: (i32,i32)→()
 *   imports: env.read32(i32)→i32, env.write32(i32,i32)→(), env.exit()→(),
 *            env.memory (min 1 page)
 *   func 0:  the translated block, exported as "run"; memory as "memory".
 *
 * CPU-state contract: the host passes an Int32Array state image backed by the
 * imported linear memory at fixed word offsets (OFF_*). The emitted code
 * mirrors r[0..31] in locals (r0 = constant zero), executes the block, then
 * syncs pc/nextPc/cycles back and calls env.exit(). LW/SW go through the
 * imported read32/write32 so host Memory/MMIO stays authoritative.
 *
 * Delay slot: a branch/jump consumes the NEXT fetch as its delay slot and the
 * block exits after it. PS1 load delay (one slot) is reproduced exactly: a
 * load's value lands in the target register at the top of the NEXT emitted
 * instruction (interpreter step() order), or in the exit sync if the load was
 * the block's last instruction.
 *
 * Exit convention: control flow converges on one epilogue via a local
 * holding the runtime exit pc (fall-through constant patched inside the
 * taken-branch `if`), so taken/not-taken both reach the same sync code.
 */
import { WasmEmitter, I32, OP, uleb, sleb } from "./emitter";

/** Basic block size cap (instructions), per contract. */
export const BLOCK_MAX = 64;

/** CPU state image layout — i32 word offsets inside the linear memory. */
export const OFF_R = 0; // r[0..31]
export const OFF_PC = 128; // word 32
export const OFF_NEXT_PC = 132; // word 33
export const OFF_HI = 136; // word 34 (untouched by this tier)
export const OFF_LO = 140; // word 35 (untouched by this tier)
export const OFF_CYCLES = 144; // word 36
export const OFF_LOAD_SLOT = 148;
export const OFF_LOAD_REG = 152;
export const OFF_LOAD_VALUE = 156;
export const OFF_BRANCH_DELAY = 160;
export const STATE_WORDS = 41;

/** Optional translation metadata used by the host instruction budget. */
export interface TranslationInfo {
  instructions: number;
}

/** A translation failure that is safe to retry with the interpreter. */
export class UnsupportedInstructionError extends Error {}

export interface DynarecHooks {
  read32(va: number): number;
  write32(va: number, v: number): void;
  exit(): void;
  /** Linear memory hosting the state image (pass 0: the state words). */
  memory: WebAssembly.Memory;
}

const VOID_BLOCK = 0x40; // if-blocktype: no results

// Fixed locals. 0..31 mirror r[0..31] (local 0 is r0, never written).
const L_LINK = 32; // reserved (kept for local-index stability: JR/JALR write shadows directly)
const L_ADDR = 33; // LW/SW computed address
const L_VALUE = 34; // LW loaded value (published next instruction)
const L_CYC = 35; // running cycle count for the block
const L_MEMTMP = 36; // i32.store operand-order scratch
const L_EXITPC = 37; // runtime exit pc (branches overwrite; +=4 per instr)
const L_NEXTPC = 38; // runtime nextPc shadow (+=4 per instr; targets when taken)
const L_BRANCH_DELAY = 39; // interpreter keeps this flag set after a transfer
const LOCALS = 40;

function regGet(t: Translator, i: number): void {
  t.code.push(OP.LOCAL_GET);
  uleb(t.code, i);
}
function regSet(t: Translator, i: number): void {
  t.code.push(OP.LOCAL_SET);
  uleb(t.code, i);
}
/** local += delta (const-carrying increment for exit-pc/cycle shadows). */
function regAddConst(t: Translator, i: number, delta: number): void {
  regGet(t, i);
  t.const32(delta);
  t.code.push(OP.I32_ADD);
  regSet(t, i);
}

class Translator {
  code: number[] = [];
  /** Instructions actually included (delay slot included). */
  n = 0;
  /** Block ended with a transfer of control (else fall-through exit). */
  transfer = false;
  private startPc = 0;
  private LD: { reg: number; val: number } | null = null;

  const32(v: number): void {
    this.code.push(OP.I32_CONST);
    sleb(this.code, v | 0);
  }

  /** i32.store into the state image; address (byte offset) is on the stack. */
  storeState(): void {
    this.code.push(OP.I32_STORE);
    uleb(this.code, 2); // align = log2(4)
    uleb(this.code, 0); // static offset MUST be 0 — it ADDS to the stack addr
  }

  /** Publish the value on the stack into GPR `reg` (r0 writes drop). */
  setGPR(reg: number): void {
    if (reg === 0) {
      this.code.push(OP.DROP);
      return;
    }
    // PS1 load-delay discard rule: an instruction writing rt cancels the
    // pending LW into rt (the loaded value is discarded, not merged).
    if (this.LD && this.LD.reg === reg) this.LD = null;
    regSet(this, reg);
  }

  /** Emit the pending load-delay write (interpreter: lands next cycle). */
  flushLoadDelay(): void {
    if (!this.LD) return;
    // Land the loaded value into the MIRROR (matches interpreter: the load
    // completes before the next instruction reads the register file). The
    // exit writeback persists the mirror into the state image.
    regGet(this, this.LD.val);
    regSet(this, this.LD.reg);
    this.LD = null;
  }

  /**
   * Emit one instruction. Kind: "simple" continues the block, "store" ends it
   * after this instruction (code-alias invalidation boundary), "branch" ends
   * it after the delay slot. Throws on opcodes outside the supported set.
   */
  emitInstr(instr: number, i: number): "simple" | "store" | "branch" {
    const op = instr >>> 26;
    const rs = (instr >>> 21) & 31;
    const rt = (instr >>> 16) & 31;
    const rd = (instr >>> 11) & 31;
    const sa = (instr >>> 6) & 31;
    const fn = instr & 63;
    const uimm = instr & 0xffff;
    const simm = (uimm << 16) >> 16;
    // pc value the interpreter has when this instruction executes
    const atPc = (this.startPc + 4 * i + 4) | 0;

    switch (op) {
      case 0x00: // SPECIAL
        switch (fn) {
          case 0x00: // SLL r[rd] = r[rt] << sa — 74 = i32.shl
            regGet(this, rt); this.const32(sa); this.code.push(OP.I32_SHL);
            this.setGPR(rd);
            return "simple";
          case 0x02: // SRL — 76 = i32.shr_u
            regGet(this, rt); this.const32(sa); this.code.push(OP.I32_SHR_U);
            this.setGPR(rd);
            return "simple";
          case 0x03: // SRA — 75 = i32.shr_s
            regGet(this, rt); this.const32(sa); this.code.push(OP.I32_SHR_S);
            this.setGPR(rd);
            return "simple";
          case 0x04: // SLLV — shift amount = r[rs] & 31
            regGet(this, rt); regGet(this, rs); this.const32(31); this.code.push(OP.I32_AND, OP.I32_SHL);
            this.setGPR(rd);
            return "simple";
          case 0x06: // SRLV
            regGet(this, rt); regGet(this, rs); this.const32(31); this.code.push(OP.I32_AND, OP.I32_SHR_U);
            this.setGPR(rd);
            return "simple";
          case 0x07: // SRAV
            regGet(this, rt); regGet(this, rs); this.const32(31); this.code.push(OP.I32_AND, OP.I32_SHR_S);
            this.setGPR(rd);
            return "simple";
          case 0x08: // JR — delay-slot prologue advances these shadows by 4
            regGet(this, rs); this.const32(-4); this.code.push(OP.I32_ADD);
            regSet(this, L_EXITPC);
            regGet(this, rs);
            regSet(this, L_NEXTPC);
            this.transfer = true;
            return "branch";
          case 0x09: { // JALR — link = instr addr + 8, exit pc = r[rs]
            this.const32(atPc + 4);
            this.setGPR(rd);
            regGet(this, rs); this.const32(-4); this.code.push(OP.I32_ADD);
            regSet(this, L_EXITPC);
            regGet(this, rs);
            regSet(this, L_NEXTPC);
            this.transfer = true;
            return "branch";
          }
          case 0x21: // ADDU — 6a = i32.add
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_ADD);
            this.setGPR(rd);
            return "simple";
          case 0x23: // SUBU — 6b = i32.sub
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_SUB);
            this.setGPR(rd);
            return "simple";
          case 0x24: // AND — 71 = i32.and
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_AND);
            this.setGPR(rd);
            return "simple";
          case 0x25: // OR — 72 = i32.or
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_OR);
            this.setGPR(rd);
            return "simple";
          case 0x26: // XOR — 73 = i32.xor
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_XOR);
            this.setGPR(rd);
            return "simple";
          case 0x27: // NOR — ~(a|b): or then xor -1
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_OR);
            this.const32(-1); this.code.push(OP.I32_XOR);
            this.setGPR(rd);
            return "simple";
          case 0x2a: // SLT — 48 = i32.lt_s
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_LT_S);
            this.setGPR(rd);
            return "simple";
          case 0x2b: // SLTU — 49 = i32.lt_u
            regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_LT_U);
            this.setGPR(rd);
            return "simple";
          default:
            throw new UnsupportedInstructionError(`dynarec: unsupported SPECIAL fn 0x${fn.toString(16)} (instr 0x${(instr >>> 0).toString(16)})`);
        }

      case 0x09: // ADDIU — 41 = i32.const, 6a = i32.add
        regGet(this, rs); this.const32(simm); this.code.push(OP.I32_ADD);
        this.setGPR(rt);
        return "simple";
      case 0x0a: // SLTI
        regGet(this, rs); this.const32(simm); this.code.push(OP.I32_LT_S);
        this.setGPR(rt);
        return "simple";
      case 0x0b: // SLTIU — unsigned compare against sign-extended imm
        regGet(this, rs); this.const32(simm); this.code.push(OP.I32_LT_U);
        this.setGPR(rt);
        return "simple";
      case 0x0c: // ANDI — zero-extended imm
        regGet(this, rs); this.const32(uimm); this.code.push(OP.I32_AND);
        this.setGPR(rt);
        return "simple";
      case 0x0d: // ORI
        regGet(this, rs); this.const32(uimm); this.code.push(OP.I32_OR);
        this.setGPR(rt);
        return "simple";
      case 0x0e: // XORI
        regGet(this, rs); this.const32(uimm); this.code.push(OP.I32_XOR);
        this.setGPR(rt);
        return "simple";
      case 0x0f: // LUI
        this.const32((uimm << 16) | 0); // imm in the high half, signed
        this.setGPR(rt);
        return "simple";

      case 0x23: { // LW — address = r[rs]+simm; value lands next instruction
        regGet(this, rs); this.const32(simm); this.code.push(OP.I32_ADD);
        regSet(this, L_ADDR);
        regGet(this, L_ADDR); this.code.push(OP.CALL); uleb(this.code, 0); // env.read32(va)
        if (rt === 0) {
          this.code.push(OP.DROP); // r0 loads still perform the bus read
        } else {
          regSet(this, L_VALUE);
          this.LD = { reg: rt, val: L_VALUE };
        }
        return "simple";
      }

      case 0x2b: // SW — block ends here (code-alias boundary per contract)
        this.flushLoadDelay(); // pending load lands before the next instr
        // i32.store takes [address][value]; call results drop (0x1a) so the
        // order stays: va scratch → drop → r[rt] → call write32 (func 1).
        regGet(this, rs); this.const32(simm); this.code.push(OP.I32_ADD);
        regSet(this, L_ADDR);
        regGet(this, L_ADDR); // re-push va: local.set consumed it
        regGet(this, rt);
        this.code.push(OP.CALL); uleb(this.code, 1); // env.write32(va, r[rt]) — void: no result
        return "store";

      case 0x02: // J
      case 0x03: // JAL
      case 0x01: // REGIMM BLTZ/BGEZ/(AL)
      case 0x04: // BEQ
      case 0x05: // BNE
        return this.emitBranch(op, instr, atPc, rs, rt, i);

      default:
        throw new UnsupportedInstructionError(`dynarec: unsupported opcode 0x${op.toString(16)} at pc 0x${(this.startPc + 4 * i) >>> 0} (instr 0x${(instr >>> 0).toString(16)})`);
    }
  }

  /**
   * Branch/jump. Conditionals emit: default exit pc, default nextPc, the
   * condition, then an `if` patching exit pc/nextPc when taken. Jumps write
   * the exit pc directly from L_LINK. Both consume the delay slot after.
   */
  private emitBranch(
    op: number, instr: number, atPc: number, rs: number, rt: number, i: number,
  ): "branch" {
    this.transfer = true;
    const uimm = instr & 0xffff;
    const simm = (uimm << 16) >> 16;
    const target = (atPc + (simm << 2)) | 0;
    const jumpTarget = ((atPc & 0xf000_0000) | ((instr & 0x03ff_ffff) << 2)) | 0;

    switch (op) {
      case 0x02: // J — exit pc = target, nextPc shadow = target + 4
      case 0x03: // JAL — r31 = instr addr + 8 (links even though always taken)
        if (op === 0x03) {
          this.const32(atPc + 4);
          this.setGPR(31);
        }
        this.const32(jumpTarget - 4);
        regSet(this, L_EXITPC);
        this.const32(jumpTarget);
        regSet(this, L_NEXTPC);
        return "branch";
    }

    // Conditional branch family. Defaults are the fall-through values; the
    // `if` patches both shadows when taken.
    const exitFall = (this.startPc + 4 * (i + 1)) | 0;
    this.const32(exitFall);
    regSet(this, L_EXITPC); // default: fall through
    this.const32(exitFall + 4);
    regSet(this, L_NEXTPC); // default nextPc
    switch (op) {
      case 0x04: // BEQ — 46 = i32.eq
        regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_EQ);
        break;
      case 0x05: // BNE — 47 = i32.ne
        regGet(this, rs); regGet(this, rt); this.code.push(OP.I32_NE);
        break;
      case 0x01: // REGIMM
        if (rt === 0x10 || rt === 0x11) {
          // BLTZAL/BGEZAL: link ALWAYS (like the interpreter), then branch
          this.const32(atPc + 4);
          this.setGPR(31);
        }
        if (rt === 0x00 || rt === 0x10) {
          // BLTZ/BLTZAL — 48 = i32.lt_s vs 0
          regGet(this, rs); this.const32(0); this.code.push(OP.I32_LT_S);
        } else if (rt === 0x01 || rt === 0x11) {
          // BGEZ/BGEZAL — 4e = i32.ge_s vs 0
          regGet(this, rs); this.const32(0); this.code.push(OP.I32_GE_S);
        } else {
          throw new UnsupportedInstructionError(`dynarec: unsupported REGIMM rt 0x${rt.toString(16)} (instr 0x${(instr >>> 0).toString(16)})`);
        }
        break;
    }
    // The delay-slot prologue adds four to both shadows.
    this.code.push(OP.IF, VOID_BLOCK);
    this.const32(target - 4);
    regSet(this, L_EXITPC);
    this.const32(target);
    regSet(this, L_NEXTPC);
    this.code.push(OP.END); // 0x0b
    return "branch";
  }

  /** Converging epilogue: sync state, call env.exit, unreachable. */
  private emitExit(): void {
    for (let reg = 1; reg < 32; reg++) {
      this.const32(OFF_R + 4 * reg);
      regGet(this, reg);
      this.storeState();
    }
    this.const32(OFF_CYCLES);
    regGet(this, L_CYC);
    this.storeState();
    this.const32(OFF_PC);
    regGet(this, L_EXITPC);
    this.storeState();
    this.const32(OFF_NEXT_PC);
    regGet(this, L_NEXTPC);
    this.storeState();
    // A load in the final instruction (including a delay slot) is still
    // pending. Keep it out of the GPR mirror and export the delay slot so the
    // next block or interpreter step publishes it at the correct boundary.
    this.const32(OFF_LOAD_SLOT); this.const32(this.LD ? 1 : 0); this.storeState();
    this.const32(OFF_LOAD_REG); this.const32(this.LD?.reg ?? 0); this.storeState();
    this.const32(OFF_LOAD_VALUE);
    if (this.LD) regGet(this, this.LD.val); else this.const32(0);
    this.storeState();
    this.const32(OFF_BRANCH_DELAY); regGet(this, L_BRANCH_DELAY); this.storeState();
    this.code.push(OP.CALL); uleb(this.code, 2); // env.exit()
    this.code.push(OP.UNREACHABLE); // 0x00 — exit never returns
  }

  translate(fetch: (a: number) => number, startPc: number): void {
    this.startPc = startPc | 0;
    // Prologue: prime GPR mirrors from the state image (locals start at 0),
    // then set the cycles / exit-pc / nextPc shadows.
    for (let reg = 1; reg < 32; reg++) {
      this.const32(OFF_R + 4 * reg);
      this.code.push(OP.I32_LOAD); uleb(this.code, 2); uleb(this.code, 0);
      regSet(this, reg);
    }
    this.const32(OFF_CYCLES);
    this.code.push(OP.I32_LOAD); uleb(this.code, 2); uleb(this.code, 0);
    regSet(this, L_CYC);
    this.const32(startPc | 0);
    regSet(this, L_EXITPC);
    this.const32((startPc + 4) | 0);
    regSet(this, L_NEXTPC);
    this.const32(OFF_BRANCH_DELAY);
    this.code.push(OP.I32_LOAD); uleb(this.code, 2); uleb(this.code, 0);
    regSet(this, L_BRANCH_DELAY);

    let i = 0;
    let done = false;
    // Branch needs its delay slot inside the cap → last startable index 62.
    while (i < BLOCK_MAX - 1 && !done) {
      // Interpreter cycle order, top of each fetch: pending load lands, then
      // the pc shadows and cycle count advance.
      this.flushLoadDelay();
      regAddConst(this, L_CYC, 1);
      regAddConst(this, L_EXITPC, 4);
      regAddConst(this, L_NEXTPC, 4);
      const instr = fetch(startPc + 4 * i) | 0;
      const kind = this.emitInstr(instr, i);
      if (kind === "store") {
        i++;
        done = true;
      } else if (kind === "branch") {
        i++; // delay slot executes no matter what
        this.flushLoadDelay();
        regAddConst(this, L_CYC, 1); // the delay slot executes a cycle too
        const d = fetch(startPc + 4 * i) | 0;
        if (this.emitInstr(d, i) !== "simple") {
          throw new UnsupportedInstructionError(`dynarec: control transfer in delay slot at pc 0x${(startPc + 4 * i) >>> 0}`);
        }
        i++;
        done = true;
      } else {
        i++;
      }
    }
    if (!done) this.flushLoadDelay();
    this.n = i;
    this.emitExit();
  }
}

/**
 * Translate a basic block starting at `startPc`, fetching instruction words
 * through `fetch` (virtual address → word). Returns the wasm binary.
 * Throws if the block contains an instruction outside the supported set.
 */
export function translateBlock(fetch: (a: number) => number, startPc: number): Uint8Array<ArrayBuffer> {
  const t = new Translator();
  t.translate(fetch, startPc);

  const localsDecl: number[] = [];
  uleb(localsDecl, 1); // one local group
  uleb(localsDecl, LOCALS);
  localsDecl.push(I32);
  const bodySize = localsDecl.length + t.code.length + 1; // + final 0x0b

  const e = new WasmEmitter();
  e.header();
  e.begin(1); // type section
  e.u32(3);
  e.type([], []); // 0: () → ()      (run: uses implicit imported memory)
  e.type([I32], [I32]); // 1: (i32) → i32   (read32)
  e.type([I32, I32], []); // 2: (i32,i32) → () (write32)
  e.end();
  e.begin(2); // import section
  e.u32(4);
  e.importFunc("env", "read32", 1); // func 0
  e.importFunc("env", "write32", 2); // func 1
  e.importFunc("env", "exit", 0); // func 2
  e.importMemory("env", "memory", 1); // memory 0, ≥1 page
  e.end();
  e.begin(3); // function section
  e.u32(1);
  e.u32(0); // defined func: type 0 — func index 3 (indices 0..2 are the imports)
  e.end();
  e.begin(7); // export section
  e.u32(2);
  e.exportName("run", 0, 3); // kind 0 = func; index 3 = defined func AFTER imports
  e.exportName("memory", 2, 0); // kind 2 = memory
  e.end();
  e.begin(10); // code section
  e.u32(1); // one body
  e.u32(bodySize);
  e.raw(localsDecl);
  e.raw(t.code);
  e.byte(OP.END);
  e.end();
  return e.finish();
}

export interface BlockExports {
  /** The translated block; state lives at words 0..36 of the shared memory. */
  run(): void;
}

/** Compile a block with host hooks; returns the ready-to-run instance. */
export function compileBlock(
  fetch: (a: number) => number, startPc: number, hooks: DynarecHooks,
): WebAssembly.Instance {
  const bytes: Uint8Array<ArrayBuffer> = translateBlock(fetch, startPc);
  const module = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(module, {
    env: { read32: hooks.read32, write32: hooks.write32, exit: hooks.exit, memory: hooks.memory },
  });
}

/** Run one translated block; the trailing unreachable traps by design. */
export function runBlock(inst: WebAssembly.Instance, _state: Int32Array): void {
  const exports: BlockExports = inst.exports as unknown as BlockExports;
  try {
    exports.run();
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    // unreachable after env.exit() — expected block termination
  }
}
