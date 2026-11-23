/**
 * Local-only commercial boot diagnostic. The game never leaves the machine.
 * Usage: bun run src/dev/commercial-boot.ts game.mdf [slices] [--json=out.json]
 *        [--compare=previous.json] [--trace]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Machine } from "../core/machine";
import { createMdfSectorProvider } from "../core/loader/mdf";
import { readIsoFile } from "../core/loader/iso9660";
import { parsePsExe } from "../core/loader/psexe";

interface Checkpoint {
  slice: number;
  pc: string;
  cycles: number;
  irq: string;
  cdrom: string;
  commands: number;
  sectors: number;
  dataWords: number;
  dma: string;
  gpu: string;
  nonBlack: number;
  handlerTruncations: number;
  vblankAcc: number;
  handlerEntry: number;
  customExit: number;
  cpuStatus: number;
}

interface CdromDebug {
  cmd: number;
  reading: boolean;
  dataPending: boolean;
  dataEnabled: boolean;
  sectorReady: boolean;
  dataOffset: number;
  queued: unknown[];
  seekTargetLba: number;
  modeReg: number;
}

const args = process.argv.slice(2);
const path = args[0];
if (!path) throw new Error("usage: commercial-boot.ts game.mdf [slices] [--json=out.json] [--compare=old.json] [--trace]");
const slices = Number(args[1] ?? 13_000);
if (!Number.isSafeInteger(slices) || slices < 1) throw new Error("slice count must be a positive integer");
const jsonPath = args.find((arg) => arg.startsWith("--json="))?.slice(7);
const comparePath = args.find((arg) => arg.startsWith("--compare="))?.slice(10);
const trace = args.includes("--trace");
const fast = args.includes("--fast");
const ramPath = args.find((arg) => arg.startsWith("--ram="))?.slice(6);

const bytes = new Uint8Array(readFileSync(path));
let sectors = 0;
let lastSector = -1;
const rawProvider = createMdfSectorProvider(bytes);
const provider = (lba: number) => {
  const data = rawProvider(lba);
  if (data) {
    sectors++;
    lastSector = lba;
  }
  return data;
};
const machine = new Machine();
if (args.includes("--dynarec")) machine.setDynarecEnabled(true);
if (args.includes("--no-dequeue") || args.includes("--no-close-event")) {
  const kernel = machine["kernel"] as unknown as { cCall(fn: number): number; bCall(fn: number): number };
  const cCall = kernel.cCall.bind(machine["kernel"]);
  kernel.cCall = (fn) => fn === 0x03 && args.includes("--no-dequeue") ? 0 : cCall(fn);
  const bCall = kernel.bCall.bind(machine["kernel"]);
  kernel.bCall = (fn) => fn === 0x09 && args.includes("--no-close-event") ? 1 : bCall(fn);
}
if (args.includes("--clear-custom-exit")) {
  const kernel = machine["kernel"] as unknown as { customExitAddress: number };
  const runHandler = machine["runHandler"].bind(machine);
  machine["runHandler"] = (entry, kind) => {
    runHandler(entry, kind);
    if (kind === "exception") (machine["kernel"] as unknown as { customExit: number }).customExit = 0;
  };
}
if (args.includes("--no-exception-hook")) {
  const runHandler = machine["runHandler"].bind(machine);
  machine["runHandler"] = (entry, kind) => {
    if (kind !== "exception") runHandler(entry, kind);
  };
}
machine.setSectorProvider(provider);
const hex = (value: number, width = 8) => (value >>> 0).toString(16).padStart(width, "0");
if (args.includes("--handler-trace")) {
  let active = 0;
  const counts = new Map<number, number>();
  const hleCounts = new Map<string, number>();
  let loopReads = 0;
  const step = machine.cpu.step.bind(machine.cpu);
  machine.cpu.step = () => {
    const pc = machine.cpu.pc >>> 0;
    if (active && pc === 0x8002bae0 && loopReads++ < 24) {
      const pA = machine.mem.load32(0x8004fd5c) >>> 0;
      const pB = machine.mem.load32(0x8004fd60) >>> 0;
      const a = (machine["portRead"](pA) ?? 0) & 0xffff;
      const b = (machine["portRead"](pB) ?? 0) & 0xffff;
      const saved = machine.mem.load32(0x8004ed00) & 0xffff;
      console.log(`redispatch saved=${hex(saved, 4)} pA=${hex(pA)} pB=${hex(pB)} a=${hex(a, 4)} b=${hex(b, 4)} mask=${hex(saved & a & b, 4)} irq=${hex(machine.irqStatus)}/${hex(machine.irqMask)}`);
    }
    return step();
  };
  const portWrite = machine["portWrite"].bind(machine);
  machine["portWrite"] = (va, value, width) => {
    if (active && va === 0x1f801070) console.log(`guest I_STAT write ${hex(value)} from ${hex(machine.cpu.pc)}`);
    const result = portWrite(va, value, width);
    if (active && va === 0x1f801070) console.log(`I_STAT after ${hex(machine.irqStatus)}`);
    return result;
  };
  const hle = machine.cpu.hleSyscall!;
  Object.defineProperty(machine.cpu, "hleSyscall", { value: (table: number, fn: number) => {
    if (active) {
      const key = `${table.toString(16)}(${fn.toString(16)})`;
      hleCounts.set(key, (hleCounts.get(key) ?? 0) + 1);
    }
    return hle(table, fn);
  } });
  const runHandler = machine["runHandler"].bind(machine);
  machine["runHandler"] = (entry: number, kind?: "event" | "vblank" | "exception") => {
    console.log(`handler enter ${hex(entry)} cycles=${machine.cpu.cycles}`);
    const before = machine.diagnostics.handlerTruncations;
    active++;
    runHandler(entry, kind);
    active--;
    console.log(`handler exit ${hex(entry)} cycles=${machine.cpu.cycles} truncations=${machine.diagnostics.handlerTruncations}`);
    if (machine.diagnostics.handlerTruncations !== before) {
      console.log("handler hot pcs", [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([pc, count]) => `${hex(pc)}=${count}`).join(" "));
      console.log(`handler kind ${machine.diagnostics.lastHandlerKind}`);
      const sp = machine.diagnostics.lastHandlerRegisters[29] ?? 0;
      console.log(`timer current=${machine.rcnt.regs[3]} saved=${hex(machine.mem.load32(sp + 0x10))} sp=${hex(sp)}`);
      console.log(`handler registers v0=${hex(machine.diagnostics.lastHandlerRegisters[2] ?? 0)} s0=${hex(machine.diagnostics.lastHandlerRegisters[16] ?? 0)} s1=${hex(machine.diagnostics.lastHandlerRegisters[17] ?? 0)} s2=${hex(machine.diagnostics.lastHandlerRegisters[18] ?? 0)} ra=${hex(machine.diagnostics.lastHandlerRegisters[31] ?? 0)}`);
      const kernel = machine["kernel"] as unknown as { interruptHandlers: { priority: number; struc: number; first: number }[] };
      console.log("interrupt chains", kernel.interruptHandlers.map((handler) => `${handler.priority}:${hex(handler.struc)}:${hex(handler.first)}`).join(" "));
      console.log("handler hle calls", [...hleCounts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => `${key}=${count}`).join(" "));
      counts.clear();
      hleCounts.clear();
    }
  };
}

const frontendBytes = readIsoFile(provider, "cdrom:\\FE.EXE;1");
if (!frontendBytes) throw new Error("No FE.EXE;1 found");
const frontend = parsePsExe(frontendBytes);
machine.loadExe(frontendBytes, frontend.pc0, frontend.t_addr, frontend.data);
const frontendSliceCount = Number(args.find((arg) => arg.startsWith("--frontend-slices="))?.split("=")[1] ?? 300);
for (let i = 0; i < frontendSliceCount; i++) {
  machine.runSlice(20_000);
  console.log(`front-end ${i + 1}/300 pc=${hex(machine.cpu.pc)} cycles=${machine.cpu.cycles} truncations=${machine.diagnostics.handlerTruncations} last=${hex(machine.diagnostics.lastHandlerEntry)}/${hex(machine.diagnostics.lastHandlerPc)}`);
}
console.log(`front-end complete pc=${hex(machine.cpu.pc)} cycles=${machine.cpu.cycles} truncations=${machine.diagnostics.handlerTruncations}`);
if (args.includes("--frontend-only")) {
  if (ramPath) writeFileSync(ramPath, machine.mem.ram);
  process.exit(0);
}
const gameBytes = readIsoFile(provider, "cdrom:\\GAME.EXE;1");
if (!gameBytes) throw new Error("No GAME.EXE;1 found");
const game = parsePsExe(gameBytes);
machine.loadExe(gameBytes, game.pc0, game.t_addr, game.data);

let commands = 0;
let dataWords = 0;
let lastCommand = -1;
const commandCounts = new Map<number, number>();
const setlocCounts = new Map<number, number>();
const cdromWrite = machine.cdrom.write.bind(machine.cdrom);
machine.cdrom.write = (addr, value) => {
  if ((addr & 3) === 1) {
    commands++;
    lastCommand = value & 0xff;
    commandCounts.set(lastCommand, (commandCounts.get(lastCommand) ?? 0) + 1);
  }
  cdromWrite(addr, value);
  if ((addr & 3) === 1 && value === 0x02) {
    const target = (machine.cdrom as unknown as CdromDebug).seekTargetLba;
    setlocCounts.set(target, (setlocCounts.get(target) ?? 0) + 1);
  }
  if ((addr & 3) === 1 && value === 0x0e) console.log(`setmode ${(machine.cdrom as unknown as CdromDebug).modeReg.toString(16)}`);
};
const readData32 = machine.cdrom.readData32.bind(machine.cdrom);
machine.cdrom.readData32 = () => {
  dataWords++;
  return readData32();
};

const pcHistory = new Uint32Array(128);
let pcHistoryIndex = 0;
if (trace) {
  const step = machine.cpu.step.bind(machine.cpu);
  machine.cpu.step = () => {
    pcHistory[pcHistoryIndex] = machine.cpu.pc >>> 0;
    pcHistoryIndex = (pcHistoryIndex + 1) % pcHistory.length;
    return step();
  };
}

function nonBlackPixels(): number {
  const frame = machine.gpu.composeDisplayFrame();
  let count = 0;
  const pixels = frame.rgba;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) count++;
  }
  return count;
}
function checkpoint(slice: number, includePixels = true): Checkpoint {
  const cd = machine.cdrom as unknown as CdromDebug;
  return {
    slice,
    pc: hex(machine.cpu.pc),
    cycles: machine.cpu.cycles,
    irq: `${hex(machine.irqStatus)}/${hex(machine.irqMask)}`,
    cdrom: `cmd=${hex(lastCommand, 2)},ifl=${machine.cdrom.regs[5]! & 7},read=${Number(cd.reading)},pending=${Number(cd.dataPending)},ready=${Number(cd.sectorReady)},enabled=${Number(cd.dataEnabled)},offset=${cd.dataOffset},queue=${cd.queued.length},lba=${lastSector}`,
    commands,
    sectors,
    dataWords,
    dma: `${hex(machine.dma.dpcr)}/${hex(machine.dma.dicr)}`,
    gpu: `${hex(machine.gpu.gpur1)}/${hex(machine.gpu.gpur2)}`,
    nonBlack: includePixels ? nonBlackPixels() : 0,
    handlerTruncations: machine.diagnostics.handlerTruncations,
    vblankAcc: machine["vblankAcc"],
    handlerEntry: (machine["kernel"] as unknown as { interruptHandler(): number }).interruptHandler(),
    customExit: (machine["kernel"] as unknown as { customExitAddress: number }).customExitAddress,
    cpuStatus: machine.cpu.cp0[12]!,
  };
}

const checkpoints: Checkpoint[] = [];
let previousSignature = "";
let completedSlices = 0;
for (let i = 0; i < slices; i++) {
  if (i === 3_000) machine.pads.pad1 = 0xffff & ~0x4008; // Start + Cross
  machine.runSlice(20_000);
  completedSlices = i + 1;
  if (fast) {
    if (i % 100 === 0 || i === slices - 1) checkpoints.push(checkpoint(i + 1));
    if ((i + 1) % 5_000 === 0) console.log(`progress ${i + 1}/${slices} ${checkpoints.at(-1)?.pc} nonBlack=${checkpoints.at(-1)?.nonBlack}`);
    continue;
  }
  const current = checkpoint(i + 1, false);
  const signature = JSON.stringify({ ...current, slice: 0, cycles: 0, nonBlack: 0 });
  if (i % 100 === 0 || signature !== previousSignature || i === slices - 1) {
    checkpoints.push({ ...current, nonBlack: nonBlackPixels() });
    previousSignature = signature;
  }
}

const result = {
  path,
  completedSlices,
  checkpoints,
  final: checkpoints.at(-1),
  commands: Object.fromEntries([...commandCounts].map(([op, count]) => [hex(op, 2), count])),
  setlocs: Object.fromEntries(setlocCounts),
  recentPcs: trace
    ? Array.from({ length: pcHistory.length }, (_, i) => hex(pcHistory[(pcHistoryIndex + i) % pcHistory.length]!))
    : undefined,
};
const serialized = JSON.stringify(result, null, 2);
if (jsonPath) writeFileSync(jsonPath, serialized + "\n");
if (ramPath) writeFileSync(ramPath, machine.mem.ram);
if (comparePath) {
  const previous = JSON.parse(readFileSync(comparePath, "utf8")) as typeof result;
  const length = Math.min(previous.checkpoints.length, checkpoints.length);
  let difference = -1;
  for (let i = 0; i < length; i++) {
    const a = { ...previous.checkpoints[i]!, slice: 0, cycles: 0 };
    const b = { ...checkpoints[i]!, slice: 0, cycles: 0 };
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      difference = i;
      console.log("first checkpoint difference", { index: i, previous: previous.checkpoints[i], current: checkpoints[i] });
      break;
    }
  }
  if (difference === -1) console.log(`No checkpoint differences in first ${length} entries`);
}
console.log(JSON.stringify({ final: result.final, commands: result.commands, setlocs: result.setlocs, recentPcs: result.recentPcs }, null, 2));
