import { BIOS_SIZE, PARALLEL_SIZE, RAM_SIZE, SCRATCHPAD_SIZE } from "./memory";
import { VRAM_H, VRAM_W } from "./gpu";
import { SPU_RAM_SIZE } from "./spu";
import type { StateSchema } from "./state-codec";

const N: StateSchema = { kind: "number" };
const B: StateSchema = { kind: "boolean" };
const T = (typed: "u8" | "u16" | "u32" | "i16" | "i32", length: number): StateSchema =>
  ({ kind: "typed", typed, length });
const A = (item: StateSchema, max = 0x100000, length?: number): StateSchema =>
  ({ kind: "array", item, max, ...(length === undefined ? {} : { length }) });
const O = (fields: Record<string, StateSchema>): StateSchema =>
  ({ kind: "object", fields: Object.entries(fields) });

const cpu = O({
  r: T("i32", 32), cp0: T("u32", 16), hi: N, lo: N, pc: N, nextPc: N, cycles: N,
  loadDelay: O({ slot: N, reg: N, value: N }), inBranchDelay: B,
});
const gpu = O({
  vram: T("u16", VRAM_W * VRAM_H), screen: T("u8", 640 * 480 * 4),
  gpur1: N, gpur2: N, dispEnable: B, displayMode: N, oddField: B, dmaDirection: N,
  horizontalStart: N, horizontalEnd: N, verticalStart: N, verticalEnd: N,
  display: O({
    x: N, y: N, width: N, height: N, enabled: B, interlaced: B, pal: B, colorDepth: N,
  }),
  gp0Mode: N, cmdWords: A(N), cmdLeft: N, primWords: A(N), texPage: N, clutBase: N,
  imgX: N, imgY: N, imgW: N, imgH: N, imgCur: N,
  fillX: N, fillY: N, fillW: N, fillH: N, fillColor: N,
  clipX1: N, clipY1: N, clipX2: N, clipY2: N, drawOffsetX: N, drawOffsetY: N,
});
const cdrom = O({
  regs: T("u8", 16), sectorBuffer: T("u8", 2352),
  paramFifo: A(N, 16), respFifo: A(N, 16), lastResp: A(N, 16), respIdx: N,
  queued: A(O({ int: N, data: A(N, 16) }), 64),
  cmd: N, cmdParams: A(N, 16), busy: B,
  stat: N, modeReg: N, seekErr: N, errCode: N,
  reading: B, dataPending: B, dataOffset: N, sectorReady: B, dataEnabled: B,
  secondPending: B, motorOn: B, shellOpen: B, idDone: B,
  seekTargetLba: N, seekTargetMsf: A(N, 3, 3),
});
const spu = O({
  regs: T("u16", 0x200), ram: T("u8", SPU_RAM_SIZE), endx: N, transferAddr: N,
  irqAddr: N, irqEnabled: B, irqPending: B,
  voices: A(O({
    decodeBuf: T("i16", 28), hist: T("i16", 4), pitchCounter: N, bufIdx: N, endx: B,
    curAddr: N, repeatAddr: N,
    env: O({
      phase: { kind: "enum", values: ["attack", "decay", "sustain", "release"] },
      level: N, counter: N,
    }),
  }), 24, 24),
});
const mdec = O({
  regs: N,
  tables: O({
    qtY: T("u8", 64), qtUV: T("u8", 64), iqY: T("i32", 64), iqUV: T("i32", 64),
    scale: T("i16", 64), customScale: B,
  }),
  blk: T("i32", 384), usedScratch: T("i32", 1), command: N, remaining: N,
  inWords: A(N), rl: A(N, 0x1000000), rlPos: N, out: A(N, 0x1000000), outPos: N,
  dmaIn: B, dmaOut: B, currentBlock: N,
});
const joypad = O({
  cards: A(O({
    present: B, image: T("u8", 128 * 1024), flag: N, command: N, step: N,
    started: B, active: B, sector: N, previous: N, checksum: N, receivedChecksum: N,
    writeData: T("u8", 128), lastAck: B,
  }), 2, 2),
  cardTransaction: B,
  rx: A(N, 8), mode: N, ctrl: N, baud: N, ack: B, irq: B,
  connected: A(B, 2, 2), analog: A(B, 2, 2), analogLocked: A(B, 2, 2), config: A(B, 2, 2),
  axes: T("u8", 8), rumbleMap: T("u8", 12), oldRumble: A(B, 2, 2),
  smallMotor: A(B, 2, 2), largeMotor: T("u8", 2),
  response: A(N, 32), sent: A(N, 32), packetIndex: N, packetPort: N, command: N, addressed: B,
});
const kernel = O({
  kernelAllocations: A(O({ address: N, size: N }), 1024),
  state: O({ heapNext: N, kernelNext: N, nextEvent: N }),
  events: A(O({
    handle: N, class: N, spec: N, mode: N, func: N, enabled: B, ready: B,
  }), 65536),
  interruptHandlers: A(O({ priority: N, struc: N, first: N }), 4096),
  pendingCallbacks: A(N, 65536), padDest: N, customExit: N,
});

/** Field order is the on-disk format. Any change requires a version bump. */
export const MACHINE_STATE_SCHEMA = O({
  memory: O({
    ram: T("u8", RAM_SIZE), parallel: T("u8", PARALLEL_SIZE),
    scratchpad: T("u8", SCRATCHPAD_SIZE), bios: T("u8", BIOS_SIZE),
  }),
  cpu,
  gte: O({ v: T("i16", 6), dr: T("i32", 32), cr: T("u32", 32) }),
  gpu,
  spu,
  cdrom,
  dma: O({ regs: T("u32", 21), dpcr: N, dicr: N }),
  rcnt: O({ regs: T("u16", 9), hblank: N }),
  mdec,
  joypad,
  kernel,
  machine: O({
    irqStatus: N, irqMask: N, vblankAcc: N, spuDmaDone: B,
    pads: O({ pad1: N, pad2: N }),
  }),
});
