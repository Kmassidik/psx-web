import { Machine } from "./machine";
import type { GpuRenderScale } from "./gpu";
import type { JoypadPort } from "./joypad";
import type { SpuAudioSink } from "./spu-audio";
import { parsePsExe } from "./loader/psexe";
import { createMdfSectorProvider } from "./loader/mdf";
import { readIsoFile } from "./loader/iso9660";
import {
  DEFAULT_SLICE_CYCLES, MAX_FRONTEND_SLICES, MAX_RUN_SLICES, SPU_SAMPLE_RATE,
  neutralInputState,
  type EmulatorWorkerError, type EmulatorWorkerEvent, type EmulatorWorkerMessage,
  type EmulatorWorkerRequest, type EmulatorWorkerResult, type MemoryCardRequest,
  type WorkerAudioChunk, type WorkerBootKind, type WorkerBootOptions, type WorkerBootResult,
  type WorkerFrame, type WorkerInputState, type WorkerLifecycle, type WorkerRumbleState, type WorkerRunResult,
} from "./emulator-worker-protocol";

export interface EmulatorWorkerScope {
  postMessage(message: EmulatorWorkerEvent, transfer?: Transferable[]): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?: () => void;
}

interface BootSource {
  buffer: ArrayBuffer;
  name: string;
  mode: "auto" | "exe" | "mdf" | "bios";
  options: WorkerBootOptions;
}

class RequestFailure extends Error {
  constructor(readonly code: EmulatorWorkerError["code"], message: string) {
    super(message);
  }
}

const fail = (code: EmulatorWorkerError["code"], message: string): never => {
  throw new RequestFailure(code, message);
};
const validId = (id: unknown): id is number =>
  typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 0xffff_ffff;
const validRevision = (revision: unknown): revision is number =>
  typeof revision === "number" && Number.isInteger(revision) && revision >= 0 && revision <= 0xffff_ffff;
function renderer(value: unknown): GpuRenderScale {
  if (value !== 1 && value !== 2 && value !== 4) {
    throw new RequestFailure("bad-request", "Renderer must be 1, 2, or 4");
  }
  return value;
}

function normalizeInput(input: WorkerInputState | undefined): WorkerInputState {
  const neutral = neutralInputState();
  if (!Array.isArray(input) || input.length !== 2) return neutral;
  return [0, 1].map((port) => {
    const pad = input[port];
    if (!pad || typeof pad !== "object") return neutral[port]!;
    const axes = Array.isArray(pad.axes) ? pad.axes : neutral[port]!.axes;
    return {
      buttons: typeof pad.buttons === "number" && Number.isFinite(pad.buttons) ? pad.buttons & 0xffff : 0xffff,
      axes: [0, 1, 2, 3].map((axis) => {
        const value = axes[axis];
        return typeof value === "number" && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      }) as unknown as WorkerInputState[0]["axes"],
      connected: pad.connected !== false,
      analog: pad.analog === true,
    };
  }) as unknown as WorkerInputState;
}

/** Synchronous owner of Machine. Browser message delivery supplies FIFO ordering. */
export class EmulatorWorkerRuntime {
  private machine: Machine | null = null;
  private source: BootSource | null = null;
  private lifecycle: WorkerLifecycle = "idle";
  private input = neutralInputState();
  private inputRevision = 0;
  private renderScale: GpuRenderScale = 1;
  private dynarec = false;
  private transfers: Transferable[] = [];
  private audioLeft = new Float32Array(MAX_RUN_SLICES * Math.ceil(DEFAULT_SLICE_CYCLES / 768));
  private audioRight = new Float32Array(this.audioLeft.length);
  private audioFrames = 0;
  private audioDropped = 0;
  private readonly rumble: [WorkerRumbleState, WorkerRumbleState] = [
    { port: 0, small: false, large: 0 },
    { port: 1, small: false, large: 0 },
  ];

  constructor(
    private readonly scope: EmulatorWorkerScope,
    private readonly machineFactory: () => Machine = () => new Machine(),
  ) {}

  get disposed(): boolean { return this.lifecycle === "disposed"; }

  private readonly audioSink = {
    push: (left: Float32Array, right: Float32Array): number => {
      const count = Math.min(left.length, right.length);
      const accepted = Math.min(count, this.audioLeft.length - this.audioFrames);
      if (accepted > 0) {
        this.audioLeft.set(left.subarray(0, accepted), this.audioFrames);
        this.audioRight.set(right.subarray(0, accepted), this.audioFrames);
        this.audioFrames += accepted;
      }
      this.audioDropped += count - accepted;
      return accepted;
    },
  } as SpuAudioSink;

  handle(message: unknown): void {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      this.postError(0, "bad-request", "Worker message must have a type");
      return;
    }
    if (message.type === "input") {
      const input = message as unknown as { revision?: unknown; state?: WorkerInputState };
      if (this.disposed) return;
      if (!validRevision(input.revision)) {
        this.postError(0, "bad-request", "Invalid input revision");
        return;
      }
      this.inputRevision = input.revision;
      this.input = normalizeInput(input.state);
      this.applyInput();
      this.scope.postMessage({ type: "input-ack", revision: input.revision });
      return;
    }
    const id = "id" in message && validId(message.id) ? message.id : 0;
    if (id === 0) {
      this.postError(0, "bad-request", "Request ID must be an integer in 1..4294967295");
      return;
    }
    if (this.disposed) {
      this.postError(id, "disposed", "Emulator worker is disposed");
      return;
    }
    this.transfers = [];
    let failureCode: EmulatorWorkerError["code"] = "internal";
    try {
      const request = message as unknown as EmulatorWorkerRequest;
      failureCode = request.type === "boot" || request.type === "reset" ? "boot"
        : request.type === "run" ? "run"
          : request.type === "save-state" || request.type === "load-state" ? "state" : "bad-request";
      const result = this.execute(request);
      this.scope.postMessage({ type: "response", id, result }, this.transfers);
    } catch (error) {
      if (message.type === "run" && !(error instanceof RequestFailure)) this.lifecycle = "paused";
      this.postError(id, error instanceof RequestFailure ? error.code : failureCode,
        error instanceof Error ? error.message : String(error));
    }
  }

  private postError(id: number, code: EmulatorWorkerError["code"], message: string): void {
    this.scope.postMessage({ type: "error", id, code, message });
  }

  private execute(request: EmulatorWorkerRequest): EmulatorWorkerResult {
    switch (request.type) {
      case "boot": return this.boot(request);
      case "run": return this.run(request);
      case "pause": {
        this.requireMachine();
        this.lifecycle = "paused";
        this.input = neutralInputState();
        this.applyInput();
        this.clearAudio();
        return { kind: "lifecycle", lifecycle: this.lifecycle };
      }
      case "resume": {
        this.requireMachine();
        if (this.lifecycle !== "paused") fail("wrong-state", "Resume requires a paused machine");
        this.lifecycle = "running";
        return { kind: "lifecycle", lifecycle: this.lifecycle };
      }
      case "reset": {
        const source = this.source;
        if (!source) throw new RequestFailure("no-machine", "No boot source is available for reset");
        this.input = neutralInputState();
        return this.bootSource(source);
      }
      case "stop": {
        this.machine?.setAudioSink(null);
        this.machine = null;
        this.source = null;
        this.lifecycle = "idle";
        this.input = neutralInputState();
        this.clearAudio();
        return { kind: "lifecycle", lifecycle: this.lifecycle };
      }
      case "frame": {
        if (request.scale !== undefined) this.renderScale = renderer(request.scale);
        return { kind: "frame", frame: this.composeFrame() };
      }
      case "save-state": {
        const bytes = this.requireMachine().saveState();
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        this.transfers.push(buffer);
        return { kind: "save-state", bytes: buffer };
      }
      case "load-state": {
        if (!(request.bytes instanceof ArrayBuffer)) fail("bad-request", "Save state must be an ArrayBuffer");
        this.requireMachine().loadState(new Uint8Array(request.bytes));
        this.lifecycle = "running";
        this.clearAudio();
        return { kind: "lifecycle", lifecycle: this.lifecycle };
      }
      case "memory-card": return this.memoryCard(request);
      case "set-renderer": {
        this.renderScale = renderer(request.scale);
        return { kind: "configured", renderer: this.renderScale };
      }
      case "set-dynarec": {
        if (typeof request.enabled !== "boolean") fail("bad-request", "Dynarec setting must be boolean");
        this.dynarec = request.enabled;
        this.machine?.setDynarecEnabled(this.dynarec);
        return { kind: "configured", dynarec: this.dynarec };
      }
      case "dispose": {
        this.machine?.setAudioSink(null);
        this.machine = null;
        this.source = null;
        this.lifecycle = "disposed";
        this.clearAudio();
        return { kind: "disposed" };
      }
      default: return fail("bad-request", "Unknown worker request");
    }
  }

  private boot(request: Extract<EmulatorWorkerRequest, { type: "boot" }>): WorkerBootResult {
    if (!(request.buffer instanceof ArrayBuffer)) fail("bad-request", "Boot image must be an ArrayBuffer");
    if (typeof request.name !== "string" || request.name.length === 0) fail("bad-request", "Boot name is required");
    if (!["auto", "exe", "mdf", "bios"].includes(request.mode)) fail("bad-request", "Unknown boot mode");
    const options = request.options ?? {};
    if (options.frontendSlices !== undefined &&
      (!Number.isInteger(options.frontendSlices) || options.frontendSlices < 0 || options.frontendSlices > MAX_FRONTEND_SLICES)) {
      fail("bad-request", `Front-end slices must be in 0..${MAX_FRONTEND_SLICES}`);
    }
    if (options.renderer !== undefined) renderer(options.renderer);
    if (options.memoryCards && (!Array.isArray(options.memoryCards) || options.memoryCards.length !== 2)) {
      fail("bad-request", "Exactly two optional memory-card slots are required");
    }
    if (request.inputRevision !== undefined) {
      if (!validRevision(request.inputRevision)) fail("bad-request", "Invalid input revision");
      this.inputRevision = request.inputRevision;
    }
    this.input = request.input ? normalizeInput(request.input) : neutralInputState();
    this.machine?.setAudioSink(null);
    this.machine = null;
    this.source = null;
    const source: BootSource = {
      buffer: request.buffer,
      name: request.name.slice(0, 1024),
      mode: request.mode,
      options: {
        dynarec: options.dynarec === true,
        renderer: options.renderer ?? this.renderScale,
        frontendSlices: options.frontendSlices ?? 300,
        memoryCards: options.memoryCards,
      },
    };
    return this.bootSource(source);
  }

  private bootSource(source: BootSource): WorkerBootResult {
    this.machine?.setAudioSink(null);
    this.machine = null;
    this.lifecycle = "idle";
    this.clearAudio();
    this.rumble[0].small = this.rumble[1].small = false;
    this.rumble[0].large = this.rumble[1].large = 0;
    const machine = this.machineFactory();
    machine.setDynarecEnabled(source.options.dynarec === true);
    machine.setAudioSink(this.audioSink);
    machine.joypad.rumble = (port, small, large) => {
      this.rumble[port].small = small;
      this.rumble[port].large = large;
    };
    for (const port of [0, 1] as const) {
      const card = source.options.memoryCards?.[port];
      if (card) machine.joypad.attachMemoryCard(port, card);
      else machine.joypad.attachMemoryCard(port);
    }
    let kind: WorkerBootKind;
    let payloadBytes: number;
    const bytes = new Uint8Array(source.buffer);
    const lowerName = source.name.toLowerCase();
    if (source.mode === "bios" || (source.mode === "auto" && bytes.byteLength === 512 * 1024 && lowerName.includes("bios"))) {
      kind = "bios";
      machine.loadBios(bytes);
      payloadBytes = bytes.byteLength;
    } else if (source.mode === "mdf" || (source.mode === "auto" && lowerName.endsWith(".mdf"))) {
      kind = "mdf";
      // The provider and reset source intentionally share this one transferred image.
      const provider = createMdfSectorProvider(bytes);
      machine.setSectorProvider(provider);
      const frontendBytes = readIsoFile(provider, "cdrom:\\FE.EXE;1");
      if (!frontendBytes) throw new Error("No front-end executable found in MDF");
      const frontend = parsePsExe(frontendBytes);
      machine.loadExe(frontendBytes, frontend.pc0, frontend.t_addr, frontend.data);
      for (let i = 0; i < (source.options.frontendSlices ?? 300); i++) machine.runSlice(DEFAULT_SLICE_CYCLES);
      const gameBytes = readIsoFile(provider, "cdrom:\\GAME.EXE;1");
      if (!gameBytes) throw new Error("No game executable found in MDF");
      const game = parsePsExe(gameBytes);
      machine.loadExe(gameBytes, game.pc0, game.t_addr, game.data);
      payloadBytes = game.t_size;
    } else {
      kind = "exe";
      const exe = parsePsExe(bytes);
      machine.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
      payloadBytes = exe.t_size;
    }
    this.machine = machine;
    this.source = source;
    this.renderScale = source.options.renderer ?? 1;
    this.dynarec = source.options.dynarec === true;
    this.lifecycle = "running";
    this.applyInput();
    this.clearAudio(); // Do not emit synchronous front-end audio as the first game batch.
    return { kind: "boot", lifecycle: this.lifecycle, name: source.name, source: kind, payloadBytes };
  }

  private run(request: Extract<EmulatorWorkerRequest, { type: "run" }>): WorkerRunResult {
    const machine = this.requireMachine();
    if (this.lifecycle !== "running") fail("wrong-state", "Run requires a running machine");
    if (!Number.isInteger(request.slices) || request.slices < 1 || request.slices > MAX_RUN_SLICES) {
      fail("bad-request", `Run slices must be an integer in 1..${MAX_RUN_SLICES}`);
    }
    if (request.scale !== undefined) this.renderScale = renderer(request.scale);
    if (request.inputRevision !== undefined) {
      if (!validRevision(request.inputRevision)) fail("bad-request", "Invalid input revision");
      this.inputRevision = request.inputRevision;
    }
    if (request.input) this.input = normalizeInput(request.input);
    this.applyInput();
    this.clearAudio();
    let ok = true;
    let completed = 0;
    while (completed < request.slices) {
      ok = machine.runSlice(DEFAULT_SLICE_CYCLES);
      completed++;
      if (!ok) break;
    }
    if (!ok) this.lifecycle = "paused";
    const result: WorkerRunResult = {
      kind: "run", lifecycle: this.lifecycle, ok, slices: completed,
      cycles: completed * DEFAULT_SLICE_CYCLES, inputRevision: this.inputRevision,
      rumble: [{ ...this.rumble[0] }, { ...this.rumble[1] }],
    };
    if (this.audioFrames > 0 || this.audioDropped > 0) result.audio = this.takeAudio();
    if (request.frame !== false) result.frame = this.composeFrame();
    return result;
  }

  private composeFrame(): WorkerFrame {
    const frame = this.requireMachine().gpu.composeDisplayFrame(this.renderScale);
    const rgba = frame.rgba.slice().buffer as ArrayBuffer;
    this.transfers.push(rgba);
    return {
      x: frame.x, y: frame.y, width: frame.width, height: frame.height,
      enabled: frame.enabled, interlaced: frame.interlaced, pal: frame.pal,
      colorDepth: frame.colorDepth, scale: frame.scale,
      enhancedGeometry: frame.enhancedGeometry, rgba,
    };
  }

  private clearAudio(): void {
    this.audioFrames = 0;
    this.audioDropped = 0;
  }

  private takeAudio(): WorkerAudioChunk {
    const left = this.audioLeft.slice(0, this.audioFrames).buffer as ArrayBuffer;
    const right = this.audioRight.slice(0, this.audioFrames).buffer as ArrayBuffer;
    this.transfers.push(left, right);
    return {
      left, right, frames: this.audioFrames, sampleRate: SPU_SAMPLE_RATE,
      droppedFrames: this.audioDropped,
    };
  }

  private memoryCard(request: MemoryCardRequest): EmulatorWorkerResult {
    const machine = this.requireMachine();
    if (request.port !== 0 && request.port !== 1) fail("bad-request", "Memory-card port must be 0 or 1");
    const port = request.port as JoypadPort;
    switch (request.operation) {
      case "attach": {
        if (request.image) machine.joypad.attachMemoryCard(port, request.image);
        else machine.joypad.attachMemoryCard(port);
        break;
      }
      case "detach": machine.joypad.detachMemoryCard(port); break;
      case "import": {
        const image = request.image;
        if (!(image instanceof ArrayBuffer)) throw new RequestFailure("bad-request", "Card import requires an ArrayBuffer");
        machine.joypad.importMemoryCard(port, image);
        break;
      }
      case "format": machine.joypad.formatMemoryCard(port); break;
      case "export": break;
      default: return fail("bad-request", "Unknown memory-card operation");
    }
    const image = machine.joypad.exportMemoryCard(port);
    const result: Extract<EmulatorWorkerResult, { kind: "memory-card" }> = {
      kind: "memory-card", port, operation: request.operation, attached: image !== undefined,
    };
    if (image) {
      const buffer = image.buffer as ArrayBuffer;
      result.image = buffer;
      this.transfers.push(buffer);
    }
    return result;
  }

  private applyInput(): void {
    const machine = this.machine;
    if (!machine) return;
    for (const port of [0, 1] as const) {
      const pad = this.input[port]!;
      machine.joypad.setConnected(port, pad.connected);
      machine.joypad.setAnalogMode(port, pad.analog);
      machine.joypad.setAxes(port, pad.axes);
    }
    machine.pads.pad1 = this.input[0]!.buttons;
    machine.pads.pad2 = this.input[1]!.buttons;
  }

  private requireMachine(): Machine {
    const machine = this.machine;
    if (!machine) throw new RequestFailure("no-machine", "No game is loaded");
    return machine;
  }
}

/** Install onto a DedicatedWorkerGlobalScope; exported separately for DOM-free tests. */
export function installEmulatorWorker(scope: EmulatorWorkerScope): EmulatorWorkerRuntime {
  const runtime = new EmulatorWorkerRuntime(scope);
  scope.onmessage = (event) => {
    runtime.handle(event.data);
    if (runtime.disposed) scope.close?.();
  };
  return runtime;
}

const candidate = globalThis as unknown as EmulatorWorkerScope & { document?: unknown };
if (typeof candidate.postMessage === "function" && typeof candidate.close === "function" && typeof candidate.document === "undefined") {
  installEmulatorWorker(candidate);
}
