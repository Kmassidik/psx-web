import { CycleBudget } from "./cycle-budget";
import type { PadButton } from "../state/config";
import {
  DEFAULT_REQUEST_TIMEOUT_MS, MAX_PENDING_HOST_REQUESTS, MAX_RUN_SLICES,
  WORKER_PAD_BITS, neutralInputState,
  type EmulatorWorkerMessage, type EmulatorWorkerRequest, type EmulatorWorkerResult,
  type MemoryCardOperation, type WorkerAudioChunk, type WorkerBootMode,
  type WorkerBootOptions, type WorkerBootResult, type WorkerFrame, type WorkerInputState,
  type WorkerLifecycle, type WorkerPadInput, type WorkerRumbleState, type WorkerRunResult,
} from "../core/emulator-worker-protocol";
import type { GpuRenderScale } from "../core/gpu";

export interface EmulatorWorkerLike {
  postMessage(message: EmulatorWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface HostFrame extends Omit<WorkerFrame, "rgba"> {
  rgba: Uint8Array<ArrayBuffer>;
}

export interface HostAudioChunk extends Omit<WorkerAudioChunk, "left" | "right"> {
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
}

export interface WorkerHostCallbacks {
  /** Called outside React, at most once for each completed run/frame request. */
  onFrame?: (frame: HostFrame) => void;
  onAudio?: (audio: HostAudioChunk) => void;
  onRumble?: (rumble: readonly [WorkerRumbleState, WorkerRumbleState]) => void;
  onLifecycle?: (lifecycle: WorkerLifecycle) => void;
  onError?: (error: WorkerHostError) => void;
}

export class WorkerHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkerHostError";
  }
}

interface PendingRequest {
  resolve: (result: EmulatorWorkerResult) => void;
  reject: (error: WorkerHostError) => void;
  timer: Parameters<typeof clearTimeout>[0];
}

type RequestInput = EmulatorWorkerRequest extends infer Request
  ? Request extends EmulatorWorkerRequest ? Omit<Request, "id"> : never : never;

const nextToken = (value: number): number => value >= 0xffff_ffff ? 1 : value + 1;

/**
 * Promise RPC plus a single-flight frame scheduler. The worker, not this host,
 * owns the boot image and Machine; frames/audio never enter the React store.
 */
export class WorkerHost {
  readonly callbacks: WorkerHostCallbacks;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private inputRevision = 1;
  private input = neutralInputState();
  private inputDirty = false;
  private inputInFlight = 0;
  private runPending = false;
  private cycleBudget = new CycleBudget();
  private lifecycle: WorkerLifecycle = "idle";
  private streaming = false;
  private failed = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly worker: EmulatorWorkerLike,
    callbacks: WorkerHostCallbacks = {},
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.callbacks = callbacks;
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = () => this.transportFailure("Worker execution failed");
    worker.onmessageerror = () => this.transportFailure("Worker message could not be deserialized");
  }

  static create(callbacks: WorkerHostCallbacks = {}, requestTimeoutMs?: number): WorkerHost {
    const worker = new Worker(new URL("/core/emulator-worker.js", window.location.origin), {
      type: "module", name: "psx-emulator",
    });
    // The browser's overloaded Worker signatures are adapted at this one DOM boundary.
    const transport = worker as unknown as EmulatorWorkerLike;
    return new WorkerHost(transport, callbacks, requestTimeoutMs);
  }

  get state(): WorkerLifecycle { return this.lifecycle; }
  get isRunning(): boolean { return this.streaming && this.lifecycle === "running"; }
  get isDisposed(): boolean { return this.disposed; }
  get pendingRequestCount(): number { return this.pending.size; }

  async boot(
    buffer: ArrayBuffer,
    name: string,
    mode: WorkerBootMode = "auto",
    options: WorkerBootOptions = {},
  ): Promise<WorkerBootResult> {
    this.stopStreaming();
    this.releaseInput();
    this.cycleBudget = new CycleBudget();
    const transfers: Transferable[] = [buffer];
    for (const card of options.memoryCards ?? []) {
      if (card && !transfers.includes(card)) transfers.push(card);
    }
    const result = await this.request({
      type: "boot", buffer, name, mode, options,
      input: this.input, inputRevision: this.inputRevision,
    }, transfers, Math.max(this.requestTimeoutMs, 60_000));
    if (result.kind !== "boot") throw new WorkerHostError("protocol", "Boot returned the wrong response");
    this.lifecycle = result.lifecycle;
    this.streaming = true;
    this.failed = false;
    this.callbacks.onLifecycle?.(this.lifecycle);
    return result;
  }

  /** Advance a bounded time budget. Calls while a batch is outstanding are no-ops. */
  async tick(elapsedMs: number, frame = true): Promise<WorkerRunResult | null> {
    if (!this.isRunning || this.runPending) return null;
    const slices = Math.min(MAX_RUN_SLICES, this.cycleBudget.advance(elapsedMs));
    if (slices === 0) return null;
    return this.runBatch(slices, frame);
  }

  /** At most one run request exists, irrespective of caller refresh rate. */
  async runBatch(slices: number, frame = true, scale?: GpuRenderScale): Promise<WorkerRunResult | null> {
    if (!this.isRunning || this.runPending) return null;
    this.runPending = true;
    this.inputDirty = false;
    try {
      const result = await this.request({
        type: "run", slices, frame, scale,
        input: this.input, inputRevision: this.inputRevision,
      });
      if (result.kind !== "run") throw new WorkerHostError("protocol", "Run returned the wrong response");
      if (!result.ok) {
        this.lifecycle = result.lifecycle;
        this.streaming = false;
        this.callbacks.onLifecycle?.(this.lifecycle);
      }
      this.emitRun(result);
      return result;
    } finally {
      this.runPending = false;
    }
  }

  async pause(): Promise<void> {
    this.stopStreaming();
    this.releaseInput();
    const result = await this.request({ type: "pause" });
    this.setLifecycleResult(result);
  }

  async resume(): Promise<void> {
    if (this.lifecycle !== "paused") throw new WorkerHostError("wrong-state", "Resume requires pause");
    const result = await this.request({ type: "resume" });
    const running = result.kind === "lifecycle" && result.lifecycle === "running";
    this.setLifecycleResult(result);
    this.cycleBudget = new CycleBudget();
    this.streaming = running;
  }

  async reset(): Promise<WorkerBootResult> {
    this.stopStreaming();
    this.releaseInput();
    this.cycleBudget = new CycleBudget();
    const result = await this.request({ type: "reset" }, [], Math.max(this.requestTimeoutMs, 60_000));
    if (result.kind !== "boot") throw new WorkerHostError("protocol", "Reset returned the wrong response");
    this.lifecycle = result.lifecycle;
    this.streaming = true;
    this.callbacks.onLifecycle?.(this.lifecycle);
    return result;
  }

  async stop(): Promise<void> {
    this.stopStreaming();
    this.releaseInput();
    this.cycleBudget = new CycleBudget();
    const result = await this.request({ type: "stop" });
    this.setLifecycleResult(result);
  }

  async saveState(): Promise<ArrayBuffer> {
    const result = await this.request({ type: "save-state" });
    if (result.kind !== "save-state") throw new WorkerHostError("protocol", "Save returned the wrong response");
    return result.bytes;
  }

  async loadState(bytes: ArrayBuffer): Promise<void> {
    this.stopStreaming();
    const result = await this.request({ type: "load-state", bytes }, [bytes]);
    this.setLifecycleResult(result);
    this.cycleBudget = new CycleBudget();
    this.streaming = this.lifecycle === "running";
  }

  async frame(scale?: GpuRenderScale): Promise<HostFrame> {
    const result = await this.request({ type: "frame", scale });
    if (result.kind !== "frame") throw new WorkerHostError("protocol", "Frame returned the wrong response");
    return this.emitFrame(result.frame);
  }

  async setRenderer(scale: GpuRenderScale): Promise<void> {
    const result = await this.request({ type: "set-renderer", scale });
    if (result.kind !== "configured") throw new WorkerHostError("protocol", "Renderer returned the wrong response");
  }

  async setDynarec(enabled: boolean): Promise<void> {
    const result = await this.request({ type: "set-dynarec", enabled });
    if (result.kind !== "configured") throw new WorkerHostError("protocol", "Dynarec returned the wrong response");
  }

  async memoryCard(port: 0 | 1, operation: MemoryCardOperation, image?: ArrayBuffer): Promise<ArrayBuffer | undefined> {
    const result = await this.request({ type: "memory-card", port, operation, image }, image ? [image] : []);
    if (result.kind !== "memory-card") throw new WorkerHostError("protocol", "Card returned the wrong response");
    return result.image;
  }

  setPad(port: 1 | 2, pad: WorkerPadInput): void {
    const snapshot: WorkerPadInput = {
      buttons: pad.buttons & 0xffff,
      axes: [pad.axes[0], pad.axes[1], pad.axes[2], pad.axes[3]],
      connected: pad.connected,
      analog: pad.analog,
    };
    this.input = port === 1 ? [snapshot, this.input[1]!] : [this.input[0]!, snapshot];
    this.inputRevision = nextToken(this.inputRevision);
    this.inputDirty = true;
    if (!this.streaming) this.flushInput();
  }

  setKeyboardButton(port: 1 | 2, button: PadButton, pressed: boolean): void {
    const previous = this.input[port - 1]!;
    const bit = WORKER_PAD_BITS[button];
    this.setPad(port, {
      ...previous,
      buttons: pressed ? previous.buttons & ~bit : previous.buttons | bit,
    });
  }

  releaseInput(): void {
    this.input = neutralInputState();
    this.inputRevision = nextToken(this.inputRevision);
    this.inputDirty = true;
    if (!this.streaming) this.flushInput();
  }

  /** Rejects all bounded RPCs, terminates the realm, and releases its sole boot image. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.disposed) return Promise.resolve();
    this.stopStreaming();
    this.disposal = this.request({ type: "dispose" }, [], 2_000)
      .catch(() => undefined)
      .then(() => {
        this.disposed = true;
        this.lifecycle = "disposed";
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.onmessageerror = null;
        this.worker.terminate();
        const error = new WorkerHostError("disposed", "Worker host is disposed");
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.inputInFlight = 0;
        this.callbacks.onLifecycle?.("disposed");
      });
    return this.disposal;
  }

  private request(input: RequestInput, transfers: Transferable[] = [], timeoutMs = this.requestTimeoutMs): Promise<EmulatorWorkerResult> {
    if (this.disposed) return Promise.reject(new WorkerHostError("disposed", "Worker host is disposed"));
    if (this.failed) return Promise.reject(new WorkerHostError("transport", "Worker has failed"));
    if (this.pending.size >= MAX_PENDING_HOST_REQUESTS) {
      return Promise.reject(new WorkerHostError("queue-limit", "Too many outstanding worker requests"));
    }
    const start = this.nextId;
    while (this.pending.has(this.nextId)) {
      this.nextId = nextToken(this.nextId);
      if (this.nextId === start) return Promise.reject(new WorkerHostError("queue-limit", "No request IDs are available"));
    }
    const id = this.nextId;
    this.nextId = nextToken(this.nextId);
    const request = { ...input, id } as EmulatorWorkerRequest;
    const { promise, resolve, reject } = Promise.withResolvers<EmulatorWorkerResult>();
    const timer = setTimeout(() => {
      // A timed-out realm cannot drain posted work; fail closed instead of queuing retries.
      this.transportFailure(`${input.type} request timed out`, "timeout");
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    try {
      this.worker.postMessage(request, transfers);
    } catch (cause) {
      clearTimeout(timer);
      this.pending.delete(id);
      reject(new WorkerHostError("transport", cause instanceof Error ? cause.message : String(cause)));
    }
    return promise;
  }

  private receive(data: unknown): void {
    if (typeof data !== "object" || data === null || !("type" in data)) return;
    if (data.type === "input-ack" && "revision" in data && typeof data.revision === "number") {
      if (data.revision === this.inputInFlight) {
        this.inputInFlight = 0;
        if (this.inputDirty && !this.streaming) this.flushInput();
      }
      return;
    }
    if ((data.type !== "response" && data.type !== "error") || !("id" in data) || typeof data.id !== "number") return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    if (data.type === "error") {
      const code = "code" in data && typeof data.code === "string" ? data.code : "worker";
      const message = "message" in data && typeof data.message === "string" ? data.message : "Worker request failed";
      const error = new WorkerHostError(code, message);
      pending.reject(error);
      this.callbacks.onError?.(error);
    } else if ("result" in data) {
      pending.resolve(data.result as EmulatorWorkerResult);
    } else {
      pending.reject(new WorkerHostError("protocol", "Worker response has no result"));
    }
  }

  private flushInput(): void {
    if (this.inputInFlight !== 0 || this.disposed || this.failed || this.lifecycle === "idle") return;
    const revision = this.inputRevision;
    this.inputInFlight = revision;
    this.inputDirty = false;
    try {
      this.worker.postMessage({ type: "input", revision, state: this.input });
    } catch {
      this.inputInFlight = 0;
    }
  }

  private emitRun(result: WorkerRunResult): void {
    if (!this.streaming && result.ok) return;
    if (result.audio) {
      this.callbacks.onAudio?.({
        ...result.audio,
        left: new Float32Array(result.audio.left),
        right: new Float32Array(result.audio.right),
      });
    }
    this.callbacks.onRumble?.(result.rumble);
    if (result.frame) this.emitFrame(result.frame);
  }

  private emitFrame(frame: WorkerFrame): HostFrame {
    const view: HostFrame = { ...frame, rgba: new Uint8Array(frame.rgba) };
    this.callbacks.onFrame?.(view);
    return view;
  }

  private setLifecycleResult(result: EmulatorWorkerResult): void {
    if (result.kind !== "lifecycle") throw new WorkerHostError("protocol", "Lifecycle returned the wrong response");
    this.lifecycle = result.lifecycle;
    this.callbacks.onLifecycle?.(this.lifecycle);
  }

  private stopStreaming(): void {
    this.streaming = false;
    if (this.lifecycle === "running") this.lifecycle = "paused";
  }

  private transportFailure(message: string, code = "transport"): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.stopStreaming();
    this.inputInFlight = 0;
    const error = new WorkerHostError(code, message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.callbacks.onError?.(error);
  }
}
