import type { Machine } from "./machine";

interface GpuState {
  vram: Uint16Array; screen: Uint8Array; gpur1: number; gpur2: number; dispEnable: boolean;
  displayMode: number; oddField: boolean; dmaDirection: number; horizontalStart: number; horizontalEnd: number;
  verticalStart: number; verticalEnd: number;
  display: { x: number; y: number; width: number; height: number; enabled: boolean;
    interlaced: boolean; pal: boolean; colorDepth: number };
  gp0Mode: number; cmdWords: number[]; cmdLeft: number; primWords: number[];
  texPage: number; clutBase: number; imgX: number; imgY: number; imgW: number; imgH: number;
  imgCur: number; fillX: number; fillY: number; fillW: number; fillH: number; fillColor: number;
  clipX1: number; clipY1: number; clipX2: number; clipY2: number;
  drawOffsetX: number; drawOffsetY: number;
}
interface CdromState {
  regs: Uint8Array; sectorBuffer: Uint8Array; paramFifo: number[]; respFifo: number[];
  lastResp: number[]; respIdx: number; queued: { int: number; data: number[] }[];
  cmd: number; cmdParams: number[]; busy: boolean; stat: number; modeReg: number;
  seekErr: number; errCode: number; reading: boolean; dataPending: boolean; dataOffset: number;
  sectorReady: boolean; dataEnabled: boolean; secondPending: boolean; motorOn: boolean;
  shellOpen: boolean; idDone: boolean; seekTargetLba: number; seekTargetMsf: number[];
}
interface SpuState {
  regs: Uint16Array; ram: Uint8Array; endx: number; transferAddr: number; irqAddr: number;
  irqEnabled: boolean; irqPending: boolean;
  voices: { decodeBuf: Int16Array; hist: Int16Array; pitchCounter: number; bufIdx: number;
    endx: boolean; curAddr: number; repeatAddr: number;
    env: { phase: string; level: number; counter: number } }[];
}
interface MdecState {
  regs: number; tables: { qtY: Uint8Array; qtUV: Uint8Array; iqY: Int32Array; iqUV: Int32Array;
    scale: Int16Array; customScale: boolean };
  blk: Int32Array; usedScratch: Int32Array; command: number; remaining: number;
  inWords: number[]; rl: number[]; rlPos: number; out: number[]; outPos: number;
  dmaIn: boolean; dmaOut: boolean; currentBlock: number;
}
interface SerializedCard {
  present: boolean; image: Uint8Array; flag: number; command: number; step: number;
  started: boolean; active: boolean; sector: number; previous: number; checksum: number;
  receivedChecksum: number; writeData: Uint8Array; lastAck: boolean;
}
interface JoypadState {
  cards: SerializedCard[]; cardTransaction: boolean;
  rx: number[]; mode: number; ctrl: number; baud: number; ack: boolean; irq: boolean;
  connected: boolean[]; analog: boolean[]; analogLocked: boolean[]; config: boolean[];
  axes: Uint8Array; rumbleMap: Uint8Array; oldRumble: boolean[]; smallMotor: boolean[];
  largeMotor: Uint8Array; response: number[]; sent: number[]; packetIndex: number;
  packetPort: number; command: number; addressed: boolean;
}
interface KernelState {
  kernelAllocations: { address: number; size: number }[];
  state: { heapNext: number; kernelNext: number; nextEvent: number };
  events: { handle: number; class: number; spec: number; mode: number; func: number;
    enabled: boolean; ready: boolean }[];
  interruptHandlers: { priority: number; struc: number; first: number }[];
  pendingCallbacks: number[]; padDest: number; customExit: number;
}
export interface MachineState {
  memory: { ram: Uint8Array; parallel: Uint8Array; scratchpad: Uint8Array; bios: Uint8Array };
  cpu: { r: Int32Array; cp0: Uint32Array; hi: number; lo: number; pc: number; nextPc: number;
    cycles: number; loadDelay: { slot: number; reg: number; value: number }; inBranchDelay: boolean };
  gte: { v: Int16Array; dr: Int32Array; cr: Uint32Array };
  gpu: GpuState; spu: SpuState; cdrom: CdromState;
  dma: { regs: Uint32Array; dpcr: number; dicr: number };
  rcnt: { regs: Uint16Array; hblank: number; irqFired: number };
  mdec: MdecState; joypad: JoypadState; kernel: KernelState;
  machine: { irqStatus: number; irqMask: number; vblankAcc: number; spuDmaDone: boolean;
    pads: { pad1: number; pad2: number } };
}

interface GpuInternal extends GpuState { display: GpuState["display"] & { rgba: Uint8Array } }
interface CdromInternal extends CdromState { sectorProvider?: unknown }
interface VoiceInternal {
  decodeBuf: Int16Array; hist: Int16Array; pitchCounter: number; bufIdx: number; endx: boolean;
  curAddr: number; repeatAddr: number;
  env: { phase: "attack" | "decay" | "sustain" | "release"; level: number; counter: number };
}
interface SpuInternal extends Omit<SpuState, "voices"> { voices: VoiceInternal[] }
interface MdecInternal extends Omit<MdecState, "rl" | "out"> { rl: Uint16Array; out: Uint32Array }
interface KernelInternal extends Omit<KernelState, "kernelAllocations"> {
  kernelAllocations: Map<number, number>;
  sectorProvider?: unknown;
}
interface CoreInternal {
  gteCore: MachineState["gte"]; kernel: KernelInternal;
  vblankAcc: number; spuDmaDone: boolean;
}

const gpuInternal = (m: Machine): GpuInternal => m.gpu as unknown as GpuInternal;
const cdromInternal = (m: Machine): CdromInternal => m.cdrom as unknown as CdromInternal;
const spuInternal = (m: Machine): SpuInternal => m.spu as unknown as SpuInternal;
const mdecInternal = (m: Machine): MdecInternal => m.mdec as unknown as MdecInternal;
interface JoypadInternal extends Omit<JoypadState, "cards"> {
  cards: Array<Omit<SerializedCard, "present"> | undefined>;
}
const joypadInternal = (m: Machine): JoypadInternal => m.joypad as unknown as JoypadInternal;
const emptyCard = (): SerializedCard => ({
  present: false, image: new Uint8Array(128 * 1024), flag: 0, command: 0, step: 0,
  started: false, active: false, sector: 0, previous: 0, checksum: 0,
  receivedChecksum: 0, writeData: new Uint8Array(128), lastAck: false,
});
const coreInternal = (m: Machine): CoreInternal => m as unknown as CoreInternal;

/** Copy every execution-affecting field; host callbacks/providers are excluded. */
export function captureMachineState(m: Machine): MachineState {
  const g = gpuInternal(m), cd = cdromInternal(m), sp = spuInternal(m);
  const md = mdecInternal(m), joy = joypadInternal(m), core = coreInternal(m);
  // Private timing state has no public accessor; this adapter is capture-only.
  const timer = m.rcnt as unknown as { hblank: number; irqFired: number };
  return {
    memory: {
      ram: m.mem.ram.slice(), parallel: m.mem.parallel.slice(),
      scratchpad: m.mem.scratchpad.slice(), bios: m.mem.bios.slice(),
    },
    cpu: {
      r: m.cpu.r.slice(), cp0: m.cpu.cp0.slice(), hi: m.cpu.hi, lo: m.cpu.lo,
      pc: m.cpu.pc, nextPc: m.cpu.nextPc, cycles: m.cpu.cycles,
      loadDelay: { ...m.cpu.loadDelay }, inBranchDelay: m.cpu.inBranchDelay,
    },
    gte: { v: core.gteCore.v.slice(), dr: core.gteCore.dr.slice(), cr: core.gteCore.cr.slice() },
    gpu: {
      vram: g.vram.slice(), screen: g.screen.slice(), gpur1: g.gpur1, gpur2: g.gpur2,
      dispEnable: g.dispEnable, displayMode: g.displayMode, oddField: g.oddField, dmaDirection: g.dmaDirection,
      horizontalStart: g.horizontalStart, horizontalEnd: g.horizontalEnd,
      verticalStart: g.verticalStart, verticalEnd: g.verticalEnd, display: {
        x: g.display.x, y: g.display.y, width: g.display.width, height: g.display.height,
        enabled: g.display.enabled, interlaced: g.display.interlaced,
        pal: g.display.pal, colorDepth: g.display.colorDepth,
      },
      gp0Mode: g.gp0Mode, cmdWords: g.cmdWords.slice(), cmdLeft: g.cmdLeft,
      primWords: g.primWords.slice(), texPage: g.texPage, clutBase: g.clutBase,
      imgX: g.imgX, imgY: g.imgY, imgW: g.imgW, imgH: g.imgH, imgCur: g.imgCur,
      fillX: g.fillX, fillY: g.fillY, fillW: g.fillW, fillH: g.fillH, fillColor: g.fillColor,
      clipX1: g.clipX1, clipY1: g.clipY1, clipX2: g.clipX2, clipY2: g.clipY2,
      drawOffsetX: g.drawOffsetX, drawOffsetY: g.drawOffsetY,
    },
    spu: {
      regs: sp.regs.slice(), ram: sp.ram.slice(), endx: sp.endx, transferAddr: sp.transferAddr,
      irqAddr: sp.irqAddr, irqEnabled: sp.irqEnabled, irqPending: sp.irqPending,
      voices: sp.voices.map((v) => ({
        decodeBuf: v.decodeBuf.slice(), hist: v.hist.slice(), pitchCounter: v.pitchCounter,
        bufIdx: v.bufIdx, endx: v.endx, curAddr: v.curAddr, repeatAddr: v.repeatAddr,
        env: { phase: v.env.phase, level: v.env.level, counter: v.env.counter },
      })),
    },
    cdrom: {
      regs: cd.regs.slice(), sectorBuffer: cd.sectorBuffer.slice(), paramFifo: cd.paramFifo.slice(),
      respFifo: cd.respFifo.slice(), lastResp: cd.lastResp.slice(), respIdx: cd.respIdx,
      queued: cd.queued.map((q) => ({ int: q.int, data: q.data.slice() })),
      cmd: cd.cmd, cmdParams: cd.cmdParams.slice(), busy: cd.busy, stat: cd.stat,
      modeReg: cd.modeReg, seekErr: cd.seekErr, errCode: cd.errCode, reading: cd.reading,
      dataPending: cd.dataPending, dataOffset: cd.dataOffset, sectorReady: cd.sectorReady,
      dataEnabled: cd.dataEnabled, secondPending: cd.secondPending, motorOn: cd.motorOn,
      shellOpen: cd.shellOpen, idDone: cd.idDone, seekTargetLba: cd.seekTargetLba,
      seekTargetMsf: cd.seekTargetMsf.slice(),
    },
    dma: { regs: m.dma.regs.slice(), dpcr: m.dma.dpcr, dicr: m.dma.dicr },
    rcnt: { regs: m.rcnt.regs.slice(), hblank: timer.hblank, irqFired: timer.irqFired },
    mdec: {
      regs: md.regs,
      tables: {
        qtY: md.tables.qtY.slice(), qtUV: md.tables.qtUV.slice(), iqY: md.tables.iqY.slice(),
        iqUV: md.tables.iqUV.slice(), scale: md.tables.scale.slice(), customScale: md.tables.customScale,
      },
      blk: md.blk.slice(), usedScratch: md.usedScratch.slice(), command: md.command,
      remaining: md.remaining, inWords: md.inWords.slice(), rl: Array.from(md.rl), rlPos: md.rlPos,
      out: Array.from(md.out), outPos: md.outPos, dmaIn: md.dmaIn, dmaOut: md.dmaOut,
      currentBlock: md.currentBlock,
    },
    joypad: {
      cards: joy.cards.map((card) => card ? { ...card, present: true, image: card.image.slice(), writeData: card.writeData.slice() } : emptyCard()),
      cardTransaction: joy.cardTransaction,
      rx: joy.rx.slice(), mode: joy.mode, ctrl: joy.ctrl, baud: joy.baud, ack: joy.ack, irq: joy.irq,
      connected: joy.connected.slice(), analog: joy.analog.slice(), analogLocked: joy.analogLocked.slice(),
      config: joy.config.slice(), axes: joy.axes.slice(), rumbleMap: joy.rumbleMap.slice(),
      oldRumble: joy.oldRumble.slice(), smallMotor: joy.smallMotor.slice(), largeMotor: joy.largeMotor.slice(),
      response: joy.response.slice(), sent: joy.sent.slice(), packetIndex: joy.packetIndex,
      packetPort: joy.packetPort, command: joy.command, addressed: joy.addressed,
    },
    kernel: {
      kernelAllocations: Array.from(core.kernel.kernelAllocations, ([address, size]) => ({ address, size })),
      state: { ...core.kernel.state }, events: core.kernel.events.map((event) => ({ ...event })),
      interruptHandlers: core.kernel.interruptHandlers.map((handler) => ({ ...handler })),
      pendingCallbacks: core.kernel.pendingCallbacks.slice(), padDest: core.kernel.padDest,
      customExit: core.kernel.customExit,
    },
    machine: {
      irqStatus: m.irqStatus, irqMask: m.irqMask, vblankAcc: core.vblankAcc,
      spuDmaDone: core.spuDmaDone, pads: { ...m.pads },
    },
  };
}

/** Apply a schema-validated state without invoking MMIO or host callbacks. */
export function restoreMachineState(m: Machine, s: MachineState): void {
  m.mem.ram.set(s.memory.ram); m.mem.parallel.set(s.memory.parallel);
  m.mem.scratchpad.set(s.memory.scratchpad); m.mem.bios.set(s.memory.bios);
  m.cpu.r.set(s.cpu.r); m.cpu.cp0.set(s.cpu.cp0); m.cpu.hi = s.cpu.hi; m.cpu.lo = s.cpu.lo;
  m.cpu.pc = s.cpu.pc; m.cpu.nextPc = s.cpu.nextPc; m.cpu.cycles = s.cpu.cycles;
  m.cpu.loadDelay = { ...s.cpu.loadDelay }; m.cpu.inBranchDelay = s.cpu.inBranchDelay;
  const core = coreInternal(m);
  core.gteCore.v.set(s.gte.v); core.gteCore.dr.set(s.gte.dr); core.gteCore.cr.set(s.gte.cr);

  const g = gpuInternal(m), gs = s.gpu;
  g.vram.set(gs.vram); g.screen.set(gs.screen); g.gpur1 = gs.gpur1; g.gpur2 = gs.gpur2;
  g.dispEnable = gs.dispEnable; g.displayMode = gs.displayMode; g.oddField = gs.oddField; g.dmaDirection = gs.dmaDirection;
  g.horizontalStart = gs.horizontalStart; g.horizontalEnd = gs.horizontalEnd;
  g.verticalStart = gs.verticalStart; g.verticalEnd = gs.verticalEnd;
  Object.assign(g.display, gs.display);
  g.gp0Mode = gs.gp0Mode; g.cmdWords = gs.cmdWords.slice(); g.cmdLeft = gs.cmdLeft;
  g.primWords = gs.primWords.slice(); g.texPage = gs.texPage; g.clutBase = gs.clutBase;
  g.imgX = gs.imgX; g.imgY = gs.imgY; g.imgW = gs.imgW; g.imgH = gs.imgH; g.imgCur = gs.imgCur;
  g.fillX = gs.fillX; g.fillY = gs.fillY; g.fillW = gs.fillW; g.fillH = gs.fillH; g.fillColor = gs.fillColor;
  g.clipX1 = gs.clipX1; g.clipY1 = gs.clipY1; g.clipX2 = gs.clipX2; g.clipY2 = gs.clipY2;
  g.drawOffsetX = gs.drawOffsetX; g.drawOffsetY = gs.drawOffsetY;
  m.gpu.invalidateHighResolution();

  const sp = spuInternal(m), ss = s.spu;
  sp.regs.set(ss.regs); sp.ram.set(ss.ram); sp.endx = ss.endx; sp.transferAddr = ss.transferAddr;
  sp.irqAddr = ss.irqAddr; sp.irqEnabled = ss.irqEnabled; sp.irqPending = ss.irqPending;
  for (let i = 0; i < sp.voices.length; i++) {
    const voice = sp.voices[i]!, saved = ss.voices[i]!;
    voice.decodeBuf.set(saved.decodeBuf); voice.hist.set(saved.hist);
    voice.pitchCounter = saved.pitchCounter; voice.bufIdx = saved.bufIdx; voice.endx = saved.endx;
    voice.curAddr = saved.curAddr; voice.repeatAddr = saved.repeatAddr;
    voice.env.phase = saved.env.phase as VoiceInternal["env"]["phase"];
    voice.env.level = saved.env.level; voice.env.counter = saved.env.counter;
  }

  const cd = cdromInternal(m), cs = s.cdrom;
  cd.regs.set(cs.regs); cd.sectorBuffer.set(cs.sectorBuffer); cd.paramFifo = cs.paramFifo.slice();
  cd.respFifo = cs.respFifo.slice(); cd.lastResp = cs.lastResp.slice(); cd.respIdx = cs.respIdx;
  cd.queued = cs.queued.map((q) => ({ int: q.int, data: q.data.slice() }));
  cd.cmd = cs.cmd; cd.cmdParams = cs.cmdParams.slice(); cd.busy = cs.busy; cd.stat = cs.stat;
  cd.modeReg = cs.modeReg; cd.seekErr = cs.seekErr; cd.errCode = cs.errCode; cd.reading = cs.reading;
  cd.dataPending = cs.dataPending; cd.dataOffset = cs.dataOffset; cd.sectorReady = cs.sectorReady;
  cd.dataEnabled = cs.dataEnabled; cd.secondPending = cs.secondPending; cd.motorOn = cs.motorOn;
  cd.shellOpen = cs.shellOpen; cd.idDone = cs.idDone; cd.seekTargetLba = cs.seekTargetLba;
  cd.seekTargetMsf = cs.seekTargetMsf.slice();
  m.dma.regs.set(s.dma.regs); m.dma.dpcr = s.dma.dpcr; m.dma.dicr = s.dma.dicr;
  // Private timing state has no public accessor; input was schema-validated.
  const timer = m.rcnt as unknown as { hblank: number; irqFired: number };
  m.rcnt.regs.set(s.rcnt.regs); timer.hblank = s.rcnt.hblank; timer.irqFired = s.rcnt.irqFired;

  const md = mdecInternal(m), ms = s.mdec;
  md.regs = ms.regs; md.tables.qtY.set(ms.tables.qtY); md.tables.qtUV.set(ms.tables.qtUV);
  md.tables.iqY.set(ms.tables.iqY); md.tables.iqUV.set(ms.tables.iqUV); md.tables.scale.set(ms.tables.scale);
  md.tables.customScale = ms.tables.customScale; md.blk.set(ms.blk); md.usedScratch.set(ms.usedScratch);
  md.command = ms.command; md.remaining = ms.remaining; md.inWords = ms.inWords.slice();
  md.rl = new Uint16Array(ms.rl); md.rlPos = ms.rlPos; md.out = new Uint32Array(ms.out);
  md.outPos = ms.outPos; md.dmaIn = ms.dmaIn; md.dmaOut = ms.dmaOut; md.currentBlock = ms.currentBlock;

  const joy = joypadInternal(m), js = s.joypad;
  for (let port = 0; port < 2; port++) {
    const saved = js.cards[port]!;
    if (!saved.present) { joy.cards[port] = undefined; continue; }
    const card = m.joypad.attachMemoryCard(port as 0 | 1, saved.image);
    Object.assign(card, {
      flag: saved.flag, command: saved.command, step: saved.step, started: saved.started,
      active: saved.active, sector: saved.sector, previous: saved.previous, checksum: saved.checksum,
      receivedChecksum: saved.receivedChecksum, writeData: saved.writeData.slice(), lastAck: saved.lastAck,
    });
  }
  joy.cardTransaction = js.cardTransaction;
  joy.rx = js.rx.slice(); joy.mode = js.mode; joy.ctrl = js.ctrl; joy.baud = js.baud;
  joy.ack = js.ack; joy.irq = js.irq; joy.connected = js.connected.slice(); joy.analog = js.analog.slice();
  joy.analogLocked = js.analogLocked.slice(); joy.config = js.config.slice(); joy.axes.set(js.axes);
  joy.rumbleMap.set(js.rumbleMap); joy.oldRumble = js.oldRumble.slice(); joy.smallMotor = js.smallMotor.slice();
  joy.largeMotor.set(js.largeMotor); joy.response = js.response.slice(); joy.sent = js.sent.slice();
  joy.packetIndex = js.packetIndex; joy.packetPort = js.packetPort; joy.command = js.command; joy.addressed = js.addressed;

  const ks = s.kernel;
  core.kernel.kernelAllocations.clear();
  for (const allocation of ks.kernelAllocations) core.kernel.kernelAllocations.set(allocation.address, allocation.size);
  Object.assign(core.kernel.state, ks.state);
  core.kernel.events.splice(0, core.kernel.events.length, ...ks.events.map((event) => ({ ...event })));
  core.kernel.interruptHandlers.splice(0, core.kernel.interruptHandlers.length,
    ...ks.interruptHandlers.map((handler) => ({ ...handler })));
  core.kernel.pendingCallbacks.splice(0, core.kernel.pendingCallbacks.length, ...ks.pendingCallbacks);
  core.kernel.padDest = ks.padDest; core.kernel.customExit = ks.customExit;
  m.irqStatus = s.machine.irqStatus; m.irqMask = s.machine.irqMask;
  core.vblankAcc = s.machine.vblankAcc; core.spuDmaDone = s.machine.spuDmaDone;
  m.pads.pad1 = s.machine.pads.pad1; m.pads.pad2 = s.machine.pads.pad2;
}
