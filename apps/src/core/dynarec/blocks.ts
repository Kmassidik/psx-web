/**
 * Block cache — the Dynarec tier's c_recompile_code host side: translate
 * once per physical pc, invalidate on stores that may alias code.
 *
 * Cache key: physical pc (KSEG0/KSEG1/KUSEG aliases map to the same block).
 * invalidate(start, end) drops every block whose byte range overlaps the
 * written range; flush() clears everything (e.g. BIOS swap). The chief wires
 * Memory stores → dynarec.invalidate so self-modifying code re-translates.
 *
 * State image: the cache owns the 41-word CPU image at the start of its own
 * 1-page linear memory; the host syncs r/pc/nextPc/hi/lo/cycles in and out
 * around each runBlock (runState/loadState).
 */
import {
  compileBlock, runBlock, STATE_WORDS, OFF_LOAD_SLOT, OFF_LOAD_REG,
  OFF_LOAD_VALUE, OFF_BRANCH_DELAY, type DynarecHooks, type TranslationInfo,
} from "./translator";

export const STATE_SIZE = STATE_WORDS; // words in the state image

/** Host-side view of the CPU state, mirrored into the dynarec memory image. */
export interface CpuState {
  r: Int32Array; // 32 GPRs
  pc: number;
  nextPc: number;
  hi: number;
  lo: number;
  cycles: number;
  loadDelay?: { slot: number; reg: number; value: number };
  inBranchDelay?: boolean;
}

const PC_WORD = 32;
const NEXT_PC_WORD = 33;
const HI_WORD = 34;
const LO_WORD = 35;
const CYCLES_WORD = 36;
const LOAD_SLOT_WORD = OFF_LOAD_SLOT >> 2;
const LOAD_REG_WORD = OFF_LOAD_REG >> 2;
const LOAD_VALUE_WORD = OFF_LOAD_VALUE >> 2;
const BRANCH_DELAY_WORD = OFF_BRANCH_DELAY >> 2;

/** Physical address: folds KSEG0/KSEG1 mirrors onto one canonical key. */
function phys(pc: number): number {
  return pc >= 0xa000_0000 ? pc - 0xa000_0000 : pc & 0x7fff_ffff;
}

export class Dynarec {
  private readonly blocks = new Map<number, WebAssembly.Instance>();
  private readonly lengths = new WeakMap<WebAssembly.Instance, number>();
  readonly memory = new WebAssembly.Memory({ initial: 1 });
  private readonly image = new Int32Array(this.memory.buffer, 0, STATE_WORDS);
  /** Debug/verification counters: compile count (invalidation forces growth). */
  compiles = 0;

  /** Compile (or fetch cached) the block at `pc`, fetching via `fetch`. */
  get(pc: number, fetch: (a: number) => number, hooks: DynarecHooks): WebAssembly.Instance {
    const key = phys(pc);
    let inst = this.blocks.get(key);
    if (!inst) {
      const info: TranslationInfo = { instructions: 0 };
      inst = compileBlock(fetch, pc, { ...hooks, memory: this.memory }, info);
      this.blocks.set(key, inst);
      this.lengths.set(inst, info.instructions);
      this.compiles++;
    }
    return inst;
  }

  /** Drop blocks overlapping [start, end) — call after stores, before runs. */
  invalidate(start: number, end: number): void {
    const s = phys(start), e = phys(end);
    for (const key of this.blocks.keys()) {
      if (key + 256 > s && key < e) this.blocks.delete(key); // ≤64 instr = ≤256 bytes
    }
  }

  /** Clear the whole cache. */
  flush(): void {
    this.blocks.clear();
  }

  get size(): number {
    return this.blocks.size;
  }

  /** Copy host CPU state into the image the emitted code operates on. */
  loadState(cpu: CpuState): void {
    // Plain CpuState callers keep their pending slot in the image between
    // blocks; Cpu callers provide it explicitly. Publish it before the first
    // translated instruction, matching the top of interpreter step().
    const slot = cpu.loadDelay?.slot ?? this.image[LOAD_SLOT_WORD]!;
    const reg = cpu.loadDelay?.reg ?? this.image[LOAD_REG_WORD]!;
    const value = cpu.loadDelay?.value ?? this.image[LOAD_VALUE_WORD]!;
    this.image.set(cpu.r, 0);
    if (slot && reg !== 0) this.image[reg] = value;
    this.image[PC_WORD] = cpu.pc;
    this.image[NEXT_PC_WORD] = cpu.nextPc;
    this.image[HI_WORD] = cpu.hi;
    this.image[LO_WORD] = cpu.lo;
    this.image[CYCLES_WORD] = cpu.cycles;
    this.image[LOAD_SLOT_WORD] = 0;
    this.image[LOAD_REG_WORD] = reg;
    this.image[LOAD_VALUE_WORD] = value;
    this.image[BRANCH_DELAY_WORD] = cpu.inBranchDelay === undefined
      ? this.image[BRANCH_DELAY_WORD]! : cpu.inBranchDelay ? 1 : 0;
  }

  /** Copy the image back after runBlock mutated it. */
  runState(cpu: CpuState): void {
    for (let i = 0; i < 32; i++) cpu.r[i] = this.image[i]!;
    cpu.pc = this.image[PC_WORD]!;
    cpu.nextPc = this.image[NEXT_PC_WORD]!;
    cpu.hi = this.image[HI_WORD]!;
    cpu.lo = this.image[LO_WORD]!;
    cpu.cycles = this.image[CYCLES_WORD]!;
    if (cpu.loadDelay) {
      cpu.loadDelay.slot = this.image[LOAD_SLOT_WORD]!;
      cpu.loadDelay.reg = this.image[LOAD_REG_WORD]!;
      cpu.loadDelay.value = this.image[LOAD_VALUE_WORD]!;
    }
    if (cpu.inBranchDelay !== undefined) cpu.inBranchDelay = this.image[BRANCH_DELAY_WORD] !== 0;
  }

  /** Execute one block, or return 0 if it exceeds the instruction budget. */
  run(
    pc: number, fetch: (a: number) => number, hooks: DynarecHooks, cpu: CpuState,
    maxInstructions = Number.POSITIVE_INFINITY,
  ): number {
    const inst = this.get(pc, fetch, hooks);
    const count = this.lengths.get(inst)!;
    if (count > maxInstructions) return 0;
    this.loadState(cpu);
    runBlock(inst, this.image);
    this.runState(cpu);
    return count;
  }
}
