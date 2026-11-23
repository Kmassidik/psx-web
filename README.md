# psx-web

PlayStation-1 emulator for the browser, built from scratch in TypeScript.
Bun toolchain, React UI, zero server-side emulation — the browser is the engine.

## Status

| Subsystem | State | Tests |
|---|---|---|
| Memory map (full 4 GiB translation) | done | exhaustive 65,536-page |
| CPU interpreter (MIPS R3000A user ISA) | done | ISA conformance vs independent models |
| GTE (geometry coprocessor) | done | RTPS vectors, RTPT≡3×RTPS 10k, UNR divide |
| GPU (VRAM, GP0, fill, polygons, CLUT tex, blends) | done | golden vectors + OOB property |
| CDROM controller (command/INT chain) | done | 23 tests |
| DMA (7 channels, linked-list, OTC) | done | 20 tests |
| SPU (24 voices, ADPCM, gauss, ADSR) | done | 27 tests |
| MDEC (macroblock decoder + DMA) | done | golden vectors + full DMA decode |
| Disc loaders (CUE/BIN, ISO, CHD v4/v5, PBP) | done | 34 tests |
| Dynarec (WASM tier, opt-in) | done | parity + self-loop browser E2E |
| UI (React, ePSXe-blueprint dialogs) | done | browser E2E + config tests |

Boot proof: a hand-assembled PS-X EXE runs the full loader → CPU → bus → GPU →
canvas pipeline, with `rgb(0,255,0)` verified in browser E2E. 3Xtreme reaches
its front-end/game executables and renders a red loading bar, but has **not**
reached a title screen or gameplay and is not yet described as playable.

Current verification: 377 unit/integration tests, strict TypeScript, and a
repeatable browser E2E scenario covering rendering, run controls, fullscreen,
audio unlock/mute/volume, persisted settings, and Native/2×/4× geometric rendering. See `TODO.md` for remaining
commercial-game, persistence, performance, and compatibility work.

## Layout

```
apps/
  src/core/      emulator core (pure TS, no DOM): memory, cpu, gte, gpu,
                 gpu-raster, cdrom, dma, spu, spu-voice, mdec*, rcnt,
                 machine (bus glue), syscall (HLE shield), hello-exe
  src/core/loader/  psexe, disc (cue/iso), chd, pbp
  src/core/dynarec/ WASM tier (in progress)
  src/ui/        React shell + dialogs cloned from the extracted ePSXe GTK UI
  src/dev/       Bun.serve dev server (no extra packages)
  tests/         bun test suites (see counts above)
knowledge-base/  RE evidence from the reference binary, build plan, extracted
                 598-widget GTK UI blueprint, session notes
assets/          branding placeholder
```

## Run

```sh
cd apps
bun install
bun test        # full suite
bun run dev     # http://localhost:5173 — drop a PS-X EXE (or bios.bin)
```

### Docker

```sh
docker build --target test -t psx-web-test .       # typecheck + full test suite
docker build --target runtime -t psx-web .
docker run --rm -p 5173:5173 psx-web
```

Open http://localhost:5173 and choose a PS-X EXE. The server binds to all
interfaces inside the container; emulation still runs entirely in the browser.

### Browser E2E

Generate a deterministic PS-X EXE with `buildHelloExe()`, then run
`apps/src/dev/browser-e2e.js` in the Puppeteer browser harness against the
running app. `PSX_E2E_URL` selects the URL and `PSX_E2E_EXE` selects the local
executable. The scenario asserts real green pixels, pause/continue/reset,
fullscreen entry/exit, and audio unlock/mute/volume controls.

For local commercial-boot diagnostics (assets never committed):

```sh
cd apps
bun run src/dev/commercial-boot.ts /path/to/game.mdf 40000 --fast
```

Add `--json=baseline.json` to retain checkpoints, `--compare=baseline.json` on a
later run, or `--trace` for a bounded recent-PC history.

## Legal

No BIOS, game ROMs, or other copyrighted data is hosted here. The user supplies
their own BIOS dump and disc images at runtime; nothing is uploaded — all
emulation is client-side.

## Design provenance

No emulator source is copied. Behavioral spec was derived by reverse-engineering
a shipped PS1 emulator binary (see `knowledge-base/BINARY-RE-MAP.md` — function
map, decompiled boot pipeline, memory layout, LWL/LWR byte-exact semantics,
UNR division algorithm) plus the no$psx documentation. Each subsystem cites the
function or spec section it mirrors; uncertain corners are marked UNVERIFIED in
code comments and pinned by tests where possible.

## Verification philosophy

Formal-first: exhaustive enumerable spaces (full memory map), independent-model
cross-checks (BigInt arithmetic, fixed-point GTE model), golden vectors (GPU
pixels), determinism/snapshot-replay properties, and real-browser e2e. CI gates
every push (`bun test` + strict `tsc`).
