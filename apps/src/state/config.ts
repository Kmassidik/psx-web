/**
 * Validated, versioned browser preferences. Disc/BIOS bytes never belong here;
 * only harmless paths, file names, and user interface preferences are stored.
 */
export type DisplayScale = "fit" | "integer" | "stretch";
export type Renderer = "native";

export const PAD_BUTTONS = [
  "Select", "L3", "R3", "Start", "Up", "Right", "Down", "Left",
  "L2", "R2", "L1", "R1", "Triangle", "Circle", "Cross", "Square",
] as const;
export type PadButton = (typeof PAD_BUTTONS)[number];
export type KeyBindings = Record<PadButton, string>;

export const DEFAULT_PAD1_KEYS: KeyBindings = {
  Select: "Backspace", L3: "", R3: "", Start: "Enter",
  Up: "ArrowUp", Right: "ArrowRight", Down: "ArrowDown", Left: "ArrowLeft",
  L2: "Digit1", R2: "Digit3", L1: "KeyQ", R1: "KeyE",
  Triangle: "KeyW", Circle: "KeyD", Cross: "KeyX", Square: "KeyA",
};

export const DEFAULT_PAD2_KEYS: KeyBindings = {
  Select: "", L3: "", R3: "", Start: "",
  Up: "", Right: "", Down: "", Left: "", L2: "", R2: "", L1: "", R1: "",
  Triangle: "", Circle: "", Cross: "", Square: "",
};

export interface PsxConfig {
  BiosPath: string;
  BiosHLE: boolean;
  CpuOverclocking: number; // 1 | 1.5 | 2 | 3 | 4 (menu_overclock_x1..x4)
  Dynarec: boolean;
  EnableGUI: boolean;
  FrameLimit: boolean;
  FrameSkip: number;
  ShowFPS: boolean;
  Vsync: boolean;
  ResolutionX: number;
  ResolutionY: number;
  Scanlines: boolean;
  Filter2D: number;
  Shader: string;
  Memcard1: string;
  Memcard2: string;
  SpuQuality: number;
  PadType1: number;
  PadType2: number;
  FastBoot: boolean;
  Widescreen: boolean;
  DisplayScale: DisplayScale;
  BilinearFilter: boolean;
  AudioVolume: number;
  Renderer: Renderer;
  Pad1Bindings: KeyBindings;
  Pad2Bindings: KeyBindings;
}

export const DEFAULT_CONFIG: PsxConfig = {
  BiosPath: "",
  BiosHLE: true,
  CpuOverclocking: 1,
  Dynarec: false,
  EnableGUI: true,
  FrameLimit: true,
  FrameSkip: 0,
  ShowFPS: false,
  Vsync: true,
  ResolutionX: 640,
  ResolutionY: 480,
  Scanlines: false,
  Filter2D: 0,
  Shader: "",
  Memcard1: "slot1.mcr",
  Memcard2: "slot2.mcr",
  SpuQuality: 1,
  PadType1: 1,
  PadType2: 0,
  FastBoot: true,
  Widescreen: false,
  DisplayScale: "fit",
  BilinearFilter: false,
  AudioVolume: 0.8,
  Renderer: "native",
  Pad1Bindings: { ...DEFAULT_PAD1_KEYS },
  Pad2Bindings: { ...DEFAULT_PAD2_KEYS },
};

const CURRENT_KEY = "psx-web.config.v2";
const LEGACY_KEY = "psx-web.config.v1";
const CONFIG_VERSION = 2;
const booleanKeys = [
  "BiosHLE", "Dynarec", "EnableGUI", "FrameLimit", "ShowFPS", "Vsync",
  "Scanlines", "FastBoot", "Widescreen", "BilinearFilter",
] as const;
const stringKeys = ["BiosPath", "Shader", "Memcard1", "Memcard2"] as const;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = integer ? Math.trunc(value) : value;
  return Math.min(max, Math.max(min, normalized));
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.replaceAll("\0", "").slice(0, 1024) : fallback;
}

function bindings(value: unknown, fallback: KeyBindings): KeyBindings {
  const source = record(value);
  const result = { ...fallback };
  for (const button of PAD_BUTTONS) {
    const code = source[button];
    if (typeof code === "string" && (code === "" || /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code))) {
      result[button] = code;
    }
  }
  return result;
}

/** Migrate raw v1 objects and versioned envelopes, rejecting future formats. */
function storedSettings(parsed: unknown): unknown {
  const source = record(parsed);
  if (!("version" in source)) return source; // original unversioned v1 format
  if (source.version !== 1 && source.version !== CONFIG_VERSION) return null;
  return source.settings ?? source.config ?? null;
}

/** Return a complete config containing only known, validated values. */
export function validateConfig(value: unknown): PsxConfig {
  const source = record(value);
  const cfg: PsxConfig = {
    ...DEFAULT_CONFIG,
    Pad1Bindings: bindings(source.Pad1Bindings, DEFAULT_PAD1_KEYS),
    Pad2Bindings: bindings(source.Pad2Bindings, DEFAULT_PAD2_KEYS),
  };
  for (const key of booleanKeys) {
    if (typeof source[key] === "boolean") cfg[key] = source[key];
  }
  for (const key of stringKeys) cfg[key] = safeString(source[key], DEFAULT_CONFIG[key]);
  cfg.CpuOverclocking = [1, 1.5, 2, 3, 4].includes(source.CpuOverclocking as number)
    ? source.CpuOverclocking as number : DEFAULT_CONFIG.CpuOverclocking;
  cfg.FrameSkip = finiteNumber(source.FrameSkip, cfg.FrameSkip, 0, 60, true);
  cfg.ResolutionX = finiteNumber(source.ResolutionX, cfg.ResolutionX, 160, 4096, true);
  cfg.ResolutionY = finiteNumber(source.ResolutionY, cfg.ResolutionY, 120, 2160, true);
  cfg.Filter2D = finiteNumber(source.Filter2D, cfg.Filter2D, 0, 4, true);
  cfg.SpuQuality = finiteNumber(source.SpuQuality, cfg.SpuQuality, 0, 4, true);
  cfg.PadType1 = finiteNumber(source.PadType1, cfg.PadType1, 0, 2, true) === 0 ? 0 : 1;
  cfg.PadType2 = finiteNumber(source.PadType2, cfg.PadType2, 0, 2, true) === 0 ? 0 : 1;
  cfg.AudioVolume = finiteNumber(source.AudioVolume, cfg.AudioVolume, 0, 1);
  cfg.DisplayScale = source.DisplayScale === "fit" || source.DisplayScale === "integer" || source.DisplayScale === "stretch"
    ? source.DisplayScale : DEFAULT_CONFIG.DisplayScale;
  cfg.Renderer = "native"; // no other renderer is implemented
  return cfg;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadConfig(storage?: Storage | null): PsxConfig {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return validateConfig(null);
  try {
    const current = target.getItem(CURRENT_KEY);
    const raw = current ?? target.getItem(LEGACY_KEY);
    return raw ? validateConfig(storedSettings(JSON.parse(raw))) : validateConfig(null);
  } catch {
    return validateConfig(null);
  }
}

export function saveConfig(cfg: PsxConfig, storage?: Storage | null): void {
  const target = storage === undefined ? browserStorage() : storage;
  if (!target) return;
  try {
    const settings = validateConfig(cfg);
    target.setItem(CURRENT_KEY, JSON.stringify({ version: CONFIG_VERSION, settings }));
  } catch {
    /* quota/private mode: validated settings remain session-local */
  }
}
