/**
 * Bounded, gesture-unlocked WebAudio output for the 44.1 kHz SPU mix.
 * The worklet owns a fixed ring; a fixed pool of transferable chunks feeds it.
 * No AudioBufferSourceNodes, timers, or audio-rate main-thread messages.
 */

export const SPU_SAMPLE_RATE = 44_100;

export type SpuAudioState =
  | "locked"
  | "unlocking"
  | "running"
  | "paused"
  | "unavailable"
  | "disposed";

export interface SpuAudioOptions {
  /** Maximum worklet queue, including the pre-roll. Default: 8192 (186 ms). */
  capacityFrames?: number;
  /** Transfer granularity. Default: 256 frames (5.8 ms). */
  chunkFrames?: number;
  /** Silence until this much audio is queued. Default: at most 2048 frames. */
  prebufferFrames?: number;
  volume?: number;
  muted?: boolean;
}

export interface SpuAudioMetrics {
  state: SpuAudioState;
  muted: boolean;
  volume: number;
  sampleRate: number;
  capacityFrames: number;
  queuedFrames: number;
  latencyMs: number;
  pushedFrames: number;
  playedFrames: number;
  underruns: number;
  underrunFrames: number;
  overruns: number;
  overrunFrames: number;
  lastError: string | null;
}

interface AudioChunk {
  data: Float32Array<ArrayBuffer> | null;
  frames: number;
}

interface WorkletMetrics {
  queuedFrames: number;
  playedFrames: number;
  underruns: number;
  underrunFrames: number;
  overruns: number;
  overrunFrames: number;
}

const EMPTY_METRICS: WorkletMetrics = {
  queuedFrames: 0,
  playedFrames: 0,
  underruns: 0,
  underrunFrames: 0,
  overruns: 0,
  overrunFrames: 0,
};

/* This is JavaScript, not a module imported by the main thread. */
const WORKLET_SOURCE = String.raw`
class SpuRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions;
    this.capacity = settings.capacityFrames;
    this.prebuffer = settings.prebufferFrames;
    this.metricInterval = settings.metricInterval;
    this.ring = new Float32Array(this.capacity * 2);
    this.read = 0;
    this.queued = 0;
    this.active = false;
    this.streaming = false;
    this.dead = false;
    this.outputFrames = 0;
    this.playedFrames = 0;
    this.underruns = 0;
    this.underrunFrames = 0;
    this.overruns = 0;
    this.overrunFrames = 0;
    this.port.onmessage = (event) => this.message(event.data);
  }

  clear() {
    this.read = 0;
    this.queued = 0;
    this.streaming = false;
  }

  recycle(message) {
    this.port.postMessage({ type: "recycle", slot: message.slot, buffer: message.buffer }, [message.buffer]);
  }

  message(message) {
    if (message.type === "samples") {
      if (!this.active || this.dead) {
        this.recycle(message);
        return;
      }
      const input = new Float32Array(message.buffer);
      const frames = Math.min(message.frames, this.capacity);
      const free = this.capacity - this.queued;
      if (frames > free) {
        const discarded = frames - free;
        this.read = (this.read + discarded) % this.capacity;
        this.queued -= discarded;
        this.overruns++;
        this.overrunFrames += discarded;
      }
      const write = (this.read + this.queued) % this.capacity;
      const first = Math.min(frames, this.capacity - write);
      for (let i = 0; i < first * 2; i++) this.ring[write * 2 + i] = input[i];
      const second = frames - first;
      for (let i = 0; i < second * 2; i++) this.ring[i] = input[first * 2 + i];
      this.queued += frames;
      if (this.queued >= this.prebuffer) this.streaming = true;
      this.recycle(message);
      return;
    }
    if (message.type === "start") {
      this.clear();
      this.active = true;
    } else if (message.type === "pause") {
      this.clear();
      this.active = false;
    } else if (message.type === "reset") {
      this.clear();
      this.playedFrames = 0;
      this.underruns = 0;
      this.underrunFrames = 0;
      this.overruns = 0;
      this.overrunFrames = 0;
    } else if (message.type === "dispose") {
      this.clear();
      this.active = false;
      this.dead = true;
    }
    this.postMetrics();
  }

  postMetrics() {
    this.port.postMessage({
      type: "metrics",
      queuedFrames: this.queued,
      playedFrames: this.playedFrames,
      underruns: this.underruns,
      underrunFrames: this.underrunFrames,
      overruns: this.overruns,
      overrunFrames: this.overrunFrames,
    });
  }

  process(_inputs, outputs) {
    if (this.dead) return false;
    const output = outputs[0];
    const left = output && output[0];
    if (!left) return true;
    const right = output[1];
    const frames = left.length;
    let available = 0;
    if (this.active && this.streaming) {
      available = Math.min(frames, this.queued);
      for (let i = 0; i < available; i++) {
        left[i] = this.ring[this.read * 2];
        if (right) right[i] = this.ring[this.read * 2 + 1];
        this.read = (this.read + 1) % this.capacity;
      }
      this.queued -= available;
      this.playedFrames += available;
      if (available < frames) {
        this.underruns++;
        this.underrunFrames += frames - available;
        this.streaming = false;
      }
    }
    left.fill(0, available);
    if (right) right.fill(0, available);
    this.outputFrames += frames;
    if (this.outputFrames >= this.metricInterval) {
      this.outputFrames = 0;
      this.postMetrics();
    }
    return true;
  }
}
registerProcessor("spu-ring-processor", SpuRingProcessor);
`;

export class SpuAudioSink {
  readonly sampleRate = SPU_SAMPLE_RATE;
  readonly capacityFrames: number;
  readonly chunkFrames: number;
  readonly prebufferFrames: number;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private initPromise: Promise<boolean> | null = null;
  private moduleLoaded = false;
  private stateValue: SpuAudioState = "locked";
  private error: string | null = null;
  private disposed = false;
  private paused = false;
  private muted: boolean;
  private volume: number;
  private activeSlot = -1;
  private readonly chunks: AudioChunk[] = [];
  private workletMetrics: WorkletMetrics = { ...EMPTY_METRICS };
  private pushed = 0;
  private mainOverruns = 0;
  private mainDroppedFrames = 0;

  constructor(options: SpuAudioOptions = {}) {
    this.capacityFrames = options.capacityFrames ?? 8192;
    this.chunkFrames = options.chunkFrames ?? 256;
    this.prebufferFrames = options.prebufferFrames ?? Math.max(1, Math.min(2048, this.capacityFrames >> 2));
    if (!Number.isInteger(this.capacityFrames) || this.capacityFrames < 1 ||
        !Number.isInteger(this.chunkFrames) || this.chunkFrames < 1 ||
        this.chunkFrames > this.capacityFrames ||
        !Number.isInteger(this.prebufferFrames) || this.prebufferFrames < 1 ||
        this.prebufferFrames > this.capacityFrames) {
      throw new RangeError("Invalid SPU audio buffer sizes");
    }
    const initialVolume = options.volume ?? 1;
    this.volume = Number.isFinite(initialVolume) ? Math.max(0, Math.min(1, initialVolume)) : 0;
    this.muted = options.muted ?? false;
    const poolSize = Math.max(4, Math.min(16, Math.ceil(this.capacityFrames / this.chunkFrames) + 1));
    for (let i = 0; i < poolSize; i++) {
      this.chunks.push({ data: new Float32Array(this.chunkFrames * 2), frames: 0 });
    }
  }

  get state(): SpuAudioState { return this.stateValue; }
  get isMuted(): boolean { return this.muted; }
  get currentVolume(): number { return this.volume; }
  get lastError(): string | null { return this.error; }

  /** Call synchronously from a pointer/key gesture. Safe to retry after denial. */
  unlock(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.ctx?.state === "running" && this.node) {
      if (this.paused) this.node.port.postMessage({ type: "pause" });
      else if (this.stateValue !== "running") this.node.port.postMessage({ type: "start" });
      this.stateValue = this.paused ? "paused" : "running";
      return Promise.resolve(true);
    }
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<boolean> {
    this.stateValue = "unlocking";
    this.error = null;
    try {
      if (!this.ctx) {
        if (typeof AudioContext === "undefined") throw new Error("WebAudio is unavailable");
        this.ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: "interactive" });
        this.ctx.addEventListener("statechange", this.onContextState);
      }
      const ctx = this.ctx;
      // Resume before awaiting module loading so transient user activation is intact.
      if (ctx.state !== "running") await ctx.resume();
      if (this.disposed) return false;
      if (ctx.state !== "running") {
        this.stateValue = "locked";
        return false;
      }
      if (!this.node) await this.createWorklet(ctx);
      if (this.disposed) return false;
      if (ctx.state !== "running") await ctx.resume();
      if (ctx.state !== "running") {
        this.stateValue = "locked";
        return false;
      }
      this.node!.port.postMessage({ type: this.paused ? "pause" : "start" });
      this.stateValue = this.paused ? "paused" : "running";
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.error = error instanceof Error ? error.message : String(error);
      this.stateValue = this.node ? "locked" : "unavailable";
      return false;
    }
  }

  private async createWorklet(ctx: AudioContext): Promise<void> {
    if (!this.moduleLoaded) {
      if (!ctx.audioWorklet) throw new Error("AudioWorklet is unavailable");
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        this.moduleLoaded = true;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (this.disposed) return;
    const node = new AudioWorkletNode(ctx, "spu-ring-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        capacityFrames: this.capacityFrames,
        prebufferFrames: this.prebufferFrames,
        metricInterval: Math.max(128, Math.floor(ctx.sampleRate / 4)),
      },
    });
    node.port.onmessage = this.onWorkletMessage;
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    node.connect(gain);
    gain.connect(ctx.destination);
    this.node = node;
    this.gain = gain;
  }

  private onWorkletMessage = (event: MessageEvent): void => {
    const message = event.data;
    if (message?.type === "recycle") {
      const chunk = this.chunks[message.slot];
      if (chunk && !chunk.data && message.buffer instanceof ArrayBuffer) {
        chunk.data = new Float32Array(message.buffer);
        chunk.frames = 0;
      }
    } else if (message?.type === "metrics") {
      this.workletMetrics = {
        queuedFrames: message.queuedFrames,
        playedFrames: message.playedFrames,
        underruns: message.underruns,
        underrunFrames: message.underrunFrames,
        overruns: message.overruns,
        overrunFrames: message.overrunFrames,
      };
    }
  };

  private onContextState = (): void => {
    if (this.disposed || !this.ctx) return;
    if (this.ctx.state === "running") {
      this.stateValue = this.paused ? "paused" : "running";
      this.node?.port.postMessage({ type: this.paused ? "pause" : "start" });
    } else {
      this.clearChunks();
      this.node?.port.postMessage({ type: "pause" });
      this.stateValue = this.ctx.state === "closed" ? "unavailable" : "locked";
    }
  };

  /** Queue interleaved stereo input. Returns frames accepted; emulation never waits. */
  push(left: Float32Array, right: Float32Array): number {
    if (this.stateValue !== "running" || this.paused || !this.node || this.ctx?.state !== "running") return 0;
    const count = Math.min(left.length, right.length);
    let offset = 0;
    while (offset < count) {
      const slot = this.acquireChunk();
      if (slot < 0) break;
      const chunk = this.chunks[slot]!;
      const data = chunk.data!;
      const frames = Math.min(count - offset, this.chunkFrames - chunk.frames);
      for (let i = 0; i < frames; i++) {
        const at = (chunk.frames + i) * 2;
        data[at] = left[offset + i]!;
        data[at + 1] = right[offset + i]!;
      }
      chunk.frames += frames;
      offset += frames;
      if (chunk.frames === this.chunkFrames) this.sendChunk(slot);
    }
    this.pushed += offset;
    if (offset < count) {
      this.mainOverruns++;
      this.mainDroppedFrames += count - offset;
    }
    return offset;
  }

  private acquireChunk(): number {
    if (this.activeSlot >= 0 && this.chunks[this.activeSlot]?.data) return this.activeSlot;
    this.activeSlot = -1;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i]!.data) {
        this.activeSlot = i;
        return i;
      }
    }
    return -1;
  }

  private sendChunk(slot: number): void {
    const chunk = this.chunks[slot]!;
    const data = chunk.data;
    if (!data || chunk.frames === 0 || !this.node) return;
    try {
      this.node.port.postMessage({
        type: "samples", slot, buffer: data.buffer, frames: chunk.frames,
      }, [data.buffer]);
      chunk.data = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.stateValue = "unavailable";
      this.mainOverruns++;
      this.mainDroppedFrames += chunk.frames;
      chunk.data = new Float32Array(this.chunkFrames * 2);
      chunk.frames = 0;
    }
    this.activeSlot = -1;
  }

  /** Send a final partial chunk, e.g. at the end of a finite test tone. */
  flush(): void {
    if (this.activeSlot >= 0 && this.chunks[this.activeSlot]?.frames) this.sendChunk(this.activeSlot);
  }

  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
    this.updateGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.updateGain();
  }

  private updateGain(): void {
    if (!this.gain || !this.ctx || this.ctx.state === "closed") return;
    this.gain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
  }

  /** Discard queued sound and ignore pushes. Does not suspend the shared clock. */
  pause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    this.clearChunks();
    this.node?.port.postMessage({ type: "pause" });
    this.stateValue = "paused";
  }

  /** Resume after pause; call from a gesture if the context was never unlocked. */
  resume(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.paused = false;
    this.clearChunks();
    return this.unlock();
  }

  /** Start a new stream (new game/reset) and zero all stream metrics. */
  reset(): void {
    if (this.disposed) return;
    this.clearChunks();
    this.workletMetrics = { ...EMPTY_METRICS };
    this.pushed = 0;
    this.mainOverruns = 0;
    this.mainDroppedFrames = 0;
    this.node?.port.postMessage({ type: "reset" });
  }

  private clearChunks(): void {
    this.activeSlot = -1;
    for (const chunk of this.chunks) chunk.frames = 0;
  }

  /** Low-frequency snapshot for menus/status; never call this from a render loop. */
  getMetrics(): SpuAudioMetrics {
    let queuedFrames = this.workletMetrics.queuedFrames;
    for (const chunk of this.chunks) queuedFrames += chunk.frames;
    return {
      state: this.stateValue,
      muted: this.muted,
      volume: this.volume,
      sampleRate: this.sampleRate,
      capacityFrames: this.capacityFrames,
      queuedFrames,
      latencyMs: queuedFrames * 1000 / this.sampleRate,
      pushedFrames: this.pushed,
      playedFrames: this.workletMetrics.playedFrames,
      underruns: this.workletMetrics.underruns,
      underrunFrames: this.workletMetrics.underrunFrames,
      overruns: this.workletMetrics.overruns + this.mainOverruns,
      overrunFrames: this.workletMetrics.overrunFrames + this.mainDroppedFrames,
      lastError: this.error,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stateValue = "disposed";
    this.clearChunks();
    const ctx = this.ctx;
    ctx?.removeEventListener("statechange", this.onContextState);
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.postMessage({ type: "dispose" });
      this.node.port.close();
      this.node.disconnect();
    }
    this.gain?.disconnect();
    this.node = null;
    this.gain = null;
    this.ctx = null;
    this.chunks.length = 0;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }
}
