/**
 * Block cache — the Dynarec tier's c_recompile_code host side: translate
 * once per physical pc, invalidate on stores that may alias code.
 *
 * Cache key: physical pc (KSEG0/KSEG1/KUSEG aliases map to the same block).
 * invalidate(start, end) drops every block whose byte range overlaps the
 * written range; flush() clears everything (e.g. BIOS swap). The chief wires
 * Memory stores → dynarec.invalidate so self-modifying code re-translates.
 *
 * State image: the cache owns the 37-word CPU image at the start of its own
 * 1-page linear memory; the host syncs r/pc/nextPc/hi/lo/cycles in and out
 * around each runBlock (runState/loadState).
 */
import { compileBlock, runBlock, STATE_WORDS, type DynarecHooks } from "./translator";

export const STATE_SIZE = STATE_WORDS; // words in the state image

/** Host-side view of the CPU state, mirrored into the dynarec memory image. */
export interface CpuState {
  r: Int32Array; // 32 GPRs
  pc: number;
  nextPc: number;
  hi: number;
  lo: number;
  cycles: number;
}

const PC_WORD = 32;
const NEXT_PC_WORD = 33;
const HI_WORD = 34;
const LO_WORD = 35;
const CYCLES_WORD = 36;

/** Physical address: folds KSEG0/KSEG1 mirrors onto one canonical key. */
function phys(pc: number): number {
  return pc >= 0xa000_0000 ? pc - 0xa000_0000 : pc & 0x7fff_ffff;
}

export class Dynarec {
  private readonly blocks = new Map<number, WebAssembly.Instance>();
  readonly memory = new WebAssembly.Memory({ initial: 1 });
  private readonly image = new Int32Array(this.memory.buffer, 0, STATE_WORDS);
  /** Debug/verification counters: compile count (invalidation forces growth). */
  compiles = 0;

  /** Compile (or fetch cached) the block at `pc`, fetching via `fetch`. */
  get(pc: number, fetch: (a: number) => number, hooks: DynarecHooks): WebAssembly.Instance {
    const key = phys(pc);
    let inst = this.blocks.get(key);
    if (!inst) {
      inst = compileBlock(fetch, pc, { ...hooks, memory: this.memory });
      this.blocks.set(key, inst);
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
    this.image.set(cpu.r, 0);
    this.image[PC_WORD] = cpu.pc;
    this.image[NEXT_PC_WORD] = cpu.nextPc;
    this.image[HI_WORD] = cpu.hi;
    this.image[LO_WORD] = cpu.lo;
    this.image[CYCLES_WORD] = cpu.cycles;
  }

  /** Copy the image back after runBlock mutated it. */
  runState(cpu: CpuState): void {
    for (let i = 0; i < 32; i++) cpu.r[i] = this.image[i]!;
    cpu.pc = this.image[PC_WORD]!;
    cpu.nextPc = this.image[NEXT_PC_WORD]!;
    cpu.hi = this.image[HI_WORD]!;
    cpu.lo = this.image[LO_WORD]!;
    cpu.cycles = this.image[CYCLES_WORD]!;
  }

  /** One cached-block execution: sync in, run, sync out. */
  run(pc: number, fetch: (a: number) => number, hooks: DynarecHooks, cpu: CpuState): void {
    const inst = this.get(pc, fetch, hooks);
    this.loadState(cpu);
    runBlock(inst, this.image);
    this.runState(cpu);
  }
}
