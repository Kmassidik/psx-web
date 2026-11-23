import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_PAD1_KEYS,
  DEFAULT_PAD2_KEYS,
  loadConfig,
  saveConfig,
  validateConfig,
  type PsxConfig,
} from "../src/state/config";

const CURRENT_KEY = "psx-web.config.v2";
const LEGACY_KEY = "psx-web.config.v1";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function envelope(settings: unknown, version = 2): string {
  return JSON.stringify({ version, settings });
}

describe("configuration defaults and validation", () => {
  test("returns complete independent defaults for missing or explicitly disabled storage", () => {
    const storage = new MemoryStorage();
    const loaded = loadConfig(storage);

    expect(loaded).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(loaded.Pad1Bindings).not.toBe(DEFAULT_CONFIG.Pad1Bindings);
    expect(loaded.Pad2Bindings).not.toBe(DEFAULT_CONFIG.Pad2Bindings);
    expect(loaded.Pad1Bindings).not.toBe(loaded.Pad2Bindings);
    expect(storage.length).toBe(0);
    expect(() => saveConfig(DEFAULT_CONFIG, null)).not.toThrow();

    loaded.Pad1Bindings.Cross = "KeyZ";
    loaded.Pad2Bindings.Up = "KeyI";
    expect(loadConfig(storage)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.Pad1Bindings).toEqual(DEFAULT_PAD1_KEYS);
    expect(DEFAULT_CONFIG.Pad2Bindings).toEqual(DEFAULT_PAD2_KEYS);
  });

  test("uses defaults for malformed roots and persisted value types", () => {
    for (const root of [null, [], "settings", 42, true]) {
      expect(validateConfig(root)).toEqual(DEFAULT_CONFIG);
    }

    const storage = new MemoryStorage({
      [CURRENT_KEY]: envelope({
        BiosPath: 123,
        BiosHLE: "false",
        CpuOverclocking: "2",
        Dynarec: 1,
        EnableGUI: null,
        FrameLimit: 0,
        FrameSkip: "3",
        ShowFPS: "true",
        Vsync: [],
        ResolutionX: "1920",
        ResolutionY: {},
        Scanlines: 1,
        Filter2D: false,
        Shader: null,
        Memcard1: ["slot1.mcr"],
        Memcard2: 2,
        SpuQuality: "high",
        PadType1: true,
        PadType2: "1",
        FastBoot: "false",
        Widescreen: 1,
        DisplayScale: "automatic",
        BilinearFilter: "yes",
        AudioVolume: "0.5",
        Renderer: "software",
        Pad1Bindings: "keyboard",
        Pad2Bindings: [],
      }),
    });

    expect(loadConfig(storage)).toEqual(DEFAULT_CONFIG);
  });

  test("normalizes numeric ranges and rejects unsupported overclock and non-finite values", () => {
    expect(validateConfig({
      CpuOverclocking: 2.5,
      FrameSkip: 100.8,
      ResolutionX: 5000.9,
      ResolutionY: 119.9,
      Filter2D: -2.8,
      SpuQuality: 9.2,
      PadType1: 2,
      PadType2: -1,
      AudioVolume: -0.25,
    })).toMatchObject({
      CpuOverclocking: 1,
      FrameSkip: 60,
      ResolutionX: 4096,
      ResolutionY: 120,
      Filter2D: 0,
      SpuQuality: 4,
      PadType1: 1,
      PadType2: 0,
      AudioVolume: 0,
    });

    expect(validateConfig({
      FrameSkip: Number.POSITIVE_INFINITY,
      ResolutionX: Number.NaN,
      ResolutionY: Number.NEGATIVE_INFINITY,
      AudioVolume: Number.NaN,
    })).toMatchObject({
      FrameSkip: 0,
      ResolutionX: 640,
      ResolutionY: 480,
      AudioVolume: 0.8,
    });

    for (const multiplier of [1, 1.5, 2, 3, 4]) {
      expect(validateConfig({ CpuOverclocking: multiplier }).CpuOverclocking).toBe(multiplier);
    }
    for (const multiplier of [0, 1.25, 2.5, 5]) {
      expect(validateConfig({ CpuOverclocking: multiplier }).CpuOverclocking).toBe(1);
    }
  });

  test("sanitizes persisted strings without replacing valid empty paths", () => {
    const longShader = `/${"s".repeat(1100)}`;
    const result = validateConfig({
      BiosPath: "bios/scph\0 5501.bin",
      Shader: longShader,
      Memcard1: "",
      Memcard2: "slot\0 2.mcr",
    });

    expect(result.BiosPath).toBe("bios/scph 5501.bin");
    expect(result.Shader).toHaveLength(1024);
    expect(result.Shader).toBe(longShader.slice(0, 1024));
    expect(result.Memcard1).toBe("");
    expect(result.Memcard2).toBe("slot 2.mcr");
  });
});

describe("versioned persistence and v1 migration", () => {
  test("migrates the original unversioned v1 format and supplies v2 defaults", () => {
    const legacy = {
      BiosPath: "bios/scph1001.bin",
      BiosHLE: false,
      CpuOverclocking: 2,
      Dynarec: true,
      EnableGUI: false,
      FrameLimit: false,
      FrameSkip: 3,
      ShowFPS: true,
      Vsync: false,
      ResolutionX: 1280,
      ResolutionY: 720,
      Scanlines: true,
      Filter2D: 2,
      Shader: "shaders/crt.glsl",
      Memcard1: "legacy-one.mcr",
      Memcard2: "legacy-two.mcr",
      SpuQuality: 3,
      PadType1: 0,
      PadType2: 1,
      FastBoot: false,
    };
    const storage = new MemoryStorage({ [LEGACY_KEY]: JSON.stringify(legacy) });

    expect(loadConfig(storage)).toEqual({
      ...DEFAULT_CONFIG,
      ...legacy,
      Widescreen: false,
      DisplayScale: "fit",
      BilinearFilter: false,
      AudioVolume: 0.8,
      Renderer: "native",
      Pad1Bindings: DEFAULT_PAD1_KEYS,
      Pad2Bindings: DEFAULT_PAD2_KEYS,
    });
  });

  test("migrates versioned v1 settings and config envelopes", () => {
    for (const container of ["settings", "config"]) {
      const raw = JSON.stringify({
        version: 1,
        [container]: {
          BiosPath: "bios/legacy.bin",
          ShowFPS: true,
          AudioVolume: 0.25,
          DisplayScale: "stretch",
        },
      });
      expect(loadConfig(new MemoryStorage({ [LEGACY_KEY]: raw }))).toEqual({
        ...DEFAULT_CONFIG,
        BiosPath: "bios/legacy.bin",
        ShowFPS: true,
        AudioVolume: 0.25,
        DisplayScale: "stretch",
      });
    }
  });

  test("prefers a current v2 save over stale legacy settings", () => {
    const storage = new MemoryStorage({
      [CURRENT_KEY]: envelope({ BiosPath: "bios/current.bin", FrameSkip: 1 }),
      [LEGACY_KEY]: JSON.stringify({ BiosPath: "bios/legacy.bin", FrameSkip: 8 }),
    });

    expect(loadConfig(storage)).toEqual({
      ...DEFAULT_CONFIG,
      BiosPath: "bios/current.bin",
      FrameSkip: 1,
    });
  });

  test("rejects malformed JSON, future versions, and missing envelope settings", () => {
    const invalidSaves = [
      "{not-json",
      envelope({ BiosPath: "bios/future.bin" }, 3),
      JSON.stringify({ version: 2 }),
      JSON.stringify({ version: 2, settings: null }),
    ];

    for (const raw of invalidSaves) {
      expect(loadConfig(new MemoryStorage({ [CURRENT_KEY]: raw }))).toEqual(DEFAULT_CONFIG);
    }
  });

  test("round-trips all valid user settings through the current storage envelope", () => {
    const config: PsxConfig = {
      ...DEFAULT_CONFIG,
      BiosPath: "bios/scph5501.bin",
      BiosHLE: false,
      CpuOverclocking: 1.5,
      Dynarec: true,
      EnableGUI: false,
      FrameLimit: false,
      FrameSkip: 2,
      ShowFPS: true,
      Vsync: false,
      ResolutionX: 1920,
      ResolutionY: 1080,
      Scanlines: true,
      Filter2D: 3,
      Shader: "shaders/crt.glsl",
      Memcard1: "game-a.mcr",
      Memcard2: "",
      SpuQuality: 2,
      PadType1: 0,
      PadType2: 1,
      FastBoot: false,
      Widescreen: true,
      DisplayScale: "integer",
      BilinearFilter: true,
      AudioVolume: 0.35,
      Renderer: "native",
      Pad1Bindings: { ...DEFAULT_PAD1_KEYS, Cross: "KeyZ", L3: "F13" },
      Pad2Bindings: { ...DEFAULT_PAD2_KEYS, Cross: "Numpad0", Start: "Enter" },
    };
    const storage = new MemoryStorage();

    saveConfig(config, storage);

    const raw = storage.getItem(CURRENT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ version: 2, settings: config });
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
    expect(loadConfig(storage)).toEqual(config);
  });
});

describe("display and keyboard mappings", () => {
  test("accepts every display scale and preserves valid display preferences", () => {
    for (const displayScale of ["fit", "integer", "stretch"] as const) {
      const storage = new MemoryStorage({
        [CURRENT_KEY]: envelope({
          DisplayScale: displayScale,
          Widescreen: true,
          BilinearFilter: true,
          ResolutionX: 1920,
          ResolutionY: 1080,
        }),
      });

      expect(loadConfig(storage)).toMatchObject({
        DisplayScale: displayScale,
        Widescreen: true,
        BilinearFilter: true,
        ResolutionX: 1920,
        ResolutionY: 1080,
        Renderer: "native",
      });
    }
  });

  test("applies partial valid keyboard remaps independently for both pads", () => {
    const result = validateConfig({
      Pad1Bindings: { Cross: "KeyZ", Circle: "ShiftRight", L3: "F13", Left: "" },
      Pad2Bindings: { Up: "KeyI", Cross: "Numpad0", Start: "Enter" },
    });

    expect(result.Pad1Bindings).toEqual({
      ...DEFAULT_PAD1_KEYS,
      Cross: "KeyZ",
      Circle: "ShiftRight",
      L3: "F13",
      Left: "",
    });
    expect(result.Pad2Bindings).toEqual({
      ...DEFAULT_PAD2_KEYS,
      Up: "KeyI",
      Cross: "Numpad0",
      Start: "Enter",
    });
  });

  test("rejects malformed key codes and unknown buttons while retaining safe defaults", () => {
    const longestCode = `K${"1".repeat(63)}`;
    const result = validateConfig({
      Pad1Bindings: {
        Select: null,
        Start: 13,
        Up: true,
        Right: "R".repeat(65),
        Down: "Arrow Down",
        Left: "Arrow-Left",
        L1: "1Key",
        R1: "KeyR\0",
        Cross: longestCode,
        Square: "A",
        ExtraButton: "KeyQ",
      },
    });

    expect(result.Pad1Bindings).toEqual({
      ...DEFAULT_PAD1_KEYS,
      Cross: longestCode,
      Square: "A",
    });
    expect(result.Pad2Bindings).toEqual(DEFAULT_PAD2_KEYS);
    expect("ExtraButton" in result.Pad1Bindings).toBe(false);
  });
});

describe("storage failure fallback", () => {
  test("returns defaults when storage reads fail", () => {
    const storage = new MemoryStorage({
      [CURRENT_KEY]: envelope({ BiosPath: "bios/valid.bin" }),
    });
    storage.getItem = () => {
      throw new Error("storage access denied");
    };

    expect(loadConfig(storage)).toEqual(DEFAULT_CONFIG);
  });

  test("keeps settings session-local when storage writes fail", () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };

    expect(() => saveConfig({
      ...DEFAULT_CONFIG,
      BiosPath: "bios/session.bin",
      AudioVolume: 0.4,
    }, storage)).not.toThrow();
    expect(storage.length).toBe(0);
  });

  test("handles a throwing browser localStorage getter and restores the global", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("browser storage disabled");
      },
    });

    try {
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
      expect(() => saveConfig(DEFAULT_CONFIG)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});
