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
}

interface CdromDebug {
  cmd: number;
  reading: boolean;
  dataPending: boolean;
  dataEnabled: boolean;
  sectorReady: boolean;
  dataOffset: number;
  queued: unknown[];
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
machine.setSectorProvider(provider);

const frontendBytes = readIsoFile(provider, "cdrom:\\FE.EXE;1");
if (!frontendBytes) throw new Error("No FE.EXE;1 found");
const frontend = parsePsExe(frontendBytes);
machine.loadExe(frontendBytes, frontend.pc0, frontend.t_addr, frontend.data);
for (let i = 0; i < 300; i++) machine.runSlice(20_000);
const gameBytes = readIsoFile(provider, "cdrom:\\GAME.EXE;1");
if (!gameBytes) throw new Error("No GAME.EXE;1 found");
const game = parsePsExe(gameBytes);
machine.loadExe(gameBytes, game.pc0, game.t_addr, game.data);

let commands = 0;
let dataWords = 0;
let lastCommand = -1;
const commandCounts = new Map<number, number>();
const cdromWrite = machine.cdrom.write.bind(machine.cdrom);
machine.cdrom.write = (addr, value) => {
  if ((addr & 3) === 1) {
    commands++;
    lastCommand = value & 0xff;
    commandCounts.set(lastCommand, (commandCounts.get(lastCommand) ?? 0) + 1);
  }
  cdromWrite(addr, value);
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

const hex = (value: number, width = 8) => (value >>> 0).toString(16).padStart(width, "0");
function nonBlackPixels(): number {
  machine.gpu.composeFrame();
  let count = 0;
  const pixels = machine.gpu.screen;
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
console.log(JSON.stringify({ final: result.final, commands: result.commands, recentPcs: result.recentPcs }, null, 2));
