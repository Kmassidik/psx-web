/**
 * Configuration store — keys identical to the reference binary's config file
 * (read_configfile/write_configuration contract). Web persistence: localStorage,
 * same defaults the binary writes (write_configfiledefault).
 */
export interface PsxConfig {
  BiosPath: string;
  BiosHLE: boolean;
  CpuOverclocking: number; // 1 | 1.5 | 2 | 3 | 4 (menu_overclock_x1..x4)
  Dynarec: boolean; // menu_dynarec vs menu_interpreter
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
}

export const DEFAULT_CONFIG: PsxConfig = {
  BiosPath: "",
  BiosHLE: true, // web build: HLE-first, real BIOS optional
  CpuOverclocking: 1,
  Dynarec: false, // interpreter is the verified baseline
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
  PadType1: 0,
  PadType2: 0,
  FastBoot: true,
  Widescreen: false,
};

const KEY = "psx-web.config.v1";

export function loadConfig(storage: Storage | null = globalThis.localStorage ?? null): PsxConfig {
  if (!storage) return { ...DEFAULT_CONFIG };
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<PsxConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: PsxConfig, storage: Storage | null = globalThis.localStorage ?? null): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* quota/private mode: settings stay session-local */
  }
}
