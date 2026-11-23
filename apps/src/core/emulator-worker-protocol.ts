import type { GpuRenderScale } from "./gpu";
import type { PadButton } from "../state/config";

export const EMULATOR_WORKER_PROTOCOL = 1;
export const DEFAULT_SLICE_CYCLES = 20_000;
export const MAX_RUN_SLICES = 170;
export const MAX_FRONTEND_SLICES = 1_000;
export const MAX_PENDING_HOST_REQUESTS = 32;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const SPU_SAMPLE_RATE = 44_100;

export type WorkerLifecycle = "idle" | "running" | "paused" | "disposed";
export type WorkerBootMode = "auto" | "exe" | "mdf" | "bios";
export type WorkerBootKind = Exclude<WorkerBootMode, "auto">;
export type MemoryCardOperation = "attach" | "detach" | "import" | "export" | "format";
export type WorkerAxes = readonly [number, number, number, number];

/** Buttons use the active-low SIO mask; 0xffff releases every button. */
export interface WorkerPadInput {
  buttons: number;
  axes: WorkerAxes;
  connected: boolean;
  analog: boolean;
}

export type WorkerInputState = readonly [WorkerPadInput, WorkerPadInput];

export const WORKER_PAD_BITS: Record<PadButton, number> = {
  Select: 0x0001, L3: 0x0002, R3: 0x0004, Start: 0x0008,
  Up: 0x0010, Right: 0x0020, Down: 0x0040, Left: 0x0080,
  L2: 0x0100, R2: 0x0200, L1: 0x0400, R1: 0x0800,
  Triangle: 0x1000, Circle: 0x2000, Cross: 0x4000, Square: 0x8000,
};

export function neutralPadInput(): WorkerPadInput {
  return { buttons: 0xffff, axes: [0, 0, 0, 0], connected: true, analog: false };
}

export function neutralInputState(): WorkerInputState {
  return [neutralPadInput(), neutralPadInput()];
}

export interface WorkerBootOptions {
  dynarec?: boolean;
  renderer?: GpuRenderScale;
  frontendSlices?: number;
  /** Initial images are retained by the worker alone so reset recreates the same cards. */
  memoryCards?: readonly [ArrayBuffer | undefined, ArrayBuffer | undefined];
}

interface Request {
  id: number;
}

export interface BootRequest extends Request {
  type: "boot";
  name: string;
  mode: WorkerBootMode;
  buffer: ArrayBuffer;
  options?: WorkerBootOptions;
  input?: WorkerInputState;
  inputRevision?: number;
}

export interface RunRequest extends Request {
  type: "run";
  slices: number;
  frame?: boolean;
  scale?: GpuRenderScale;
  input?: WorkerInputState;
  inputRevision?: number;
}

export interface FrameRequest extends Request {
  type: "frame";
  scale?: GpuRenderScale;
}

export interface LoadStateRequest extends Request {
  type: "load-state";
  bytes: ArrayBuffer;
}

export interface MemoryCardRequest extends Request {
  type: "memory-card";
  port: 0 | 1;
  operation: MemoryCardOperation;
  image?: ArrayBuffer;
}

export type EmulatorWorkerRequest =
  | BootRequest
  | RunRequest
  | FrameRequest
  | LoadStateRequest
  | MemoryCardRequest
  | (Request & { type: "pause" | "resume" | "reset" | "stop" | "save-state" | "dispose" })
  | (Request & { type: "set-renderer"; scale: GpuRenderScale })
  | (Request & { type: "set-dynarec"; enabled: boolean });

/** Coalesced by WorkerHost: at most one standalone input message is in flight. */
export interface EmulatorWorkerInputMessage {
  type: "input";
  revision: number;
  state: WorkerInputState;
}

export type EmulatorWorkerMessage = EmulatorWorkerRequest | EmulatorWorkerInputMessage;

export interface WorkerFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  interlaced: boolean;
  pal: boolean;
  colorDepth: 15 | 24;
  scale: GpuRenderScale;
  enhancedGeometry: boolean;
  rgba: ArrayBuffer;
}

export interface WorkerAudioChunk {
  left: ArrayBuffer;
  right: ArrayBuffer;
  frames: number;
  sampleRate: number;
  droppedFrames: number;
}

export interface WorkerRumbleState {
  port: 0 | 1;
  small: boolean;
  large: number;
}

export interface WorkerBootResult {
  kind: "boot";
  lifecycle: WorkerLifecycle;
  name: string;
  source: WorkerBootKind;
  payloadBytes: number;
}

export interface WorkerRunResult {
  kind: "run";
  lifecycle: WorkerLifecycle;
  ok: boolean;
  slices: number;
  cycles: number;
  inputRevision: number;
  frame?: WorkerFrame;
  audio?: WorkerAudioChunk;
  rumble: readonly [WorkerRumbleState, WorkerRumbleState];
}

export type EmulatorWorkerResult =
  | WorkerBootResult
  | WorkerRunResult
  | { kind: "lifecycle"; lifecycle: WorkerLifecycle }
  | { kind: "frame"; frame: WorkerFrame }
  | { kind: "save-state"; bytes: ArrayBuffer }
  | { kind: "memory-card"; port: 0 | 1; operation: MemoryCardOperation; attached: boolean; image?: ArrayBuffer }
  | { kind: "configured"; renderer?: GpuRenderScale; dynarec?: boolean }
  | { kind: "disposed" };

export interface EmulatorWorkerResponse {
  type: "response";
  id: number;
  result: EmulatorWorkerResult;
}

export interface EmulatorWorkerError {
  type: "error";
  /** Zero is used only when the incoming request ID itself was invalid. */
  id: number;
  code: "bad-request" | "no-machine" | "wrong-state" | "boot" | "run" | "state" | "disposed" | "internal";
  message: string;
}

export interface EmulatorWorkerInputAck {
  type: "input-ack";
  revision: number;
}

export type EmulatorWorkerEvent = EmulatorWorkerResponse | EmulatorWorkerError | EmulatorWorkerInputAck;
