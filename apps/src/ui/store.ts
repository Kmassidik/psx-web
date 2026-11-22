/**
 * Minimal pub-sub store — the ONLY React-facing state.
 * Emulator memory/frames never pass through here (low-RAM rule).
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_CONFIG, type PsxConfig } from "../state/config";

export type RunState = "idle" | "loaded" | "running" | "paused" | "error";

interface AppState {
  config: PsxConfig;
  run: RunState;
  statusLine: string; // 1 Hz status: fps, region, disc (mirrors fpsDisplayFull)
  lastError: string;
}

let state: AppState = {
  config: DEFAULT_CONFIG,
  run: "idle",
  statusLine: "ready",
  lastError: "",
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function setConfig(patch: Partial<PsxConfig>): void {
  state = { ...state, config: { ...state.config, ...patch } };
  for (const l of listeners) l();
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}
