# BUILD PLAN — PSX web player, from scratch (React + TypeScript)

Evidence source: ePSXe 2.0.5 Linux x64 RE (Ghidra 12.2, 2,549 functions recovered).
No external repo, no copied code. Every module cites the binary function it mirrors.

## Hard truth (scope, stated up front)
A PS1 emulator = CPU (MIPS R3000A + GTE) + GPU + SPU + CDROM + MDEC + timers.
The RE gives us the complete *spec* (see BINARY-RE-MAP.md). Implementing it from
scratch is phased work; the CPU interpreter alone is the biggest single piece.
Order below is chosen so something boots early and each phase is verifiable.

## Architecture
```
apps/src/
  core/            ← pure TS, zero DOM, unit-testable
    memory.ts      ← mirrors init_psx_memory: RAM 2MiB, PARALLEL 128KiB,
                     SCRATCHPAD 1KiB, ICache idx; ONE ArrayBuffer, subarray views
    cpu/           ← interpreter.ts (run_interpreter), opcodes R_*, BranchDelay,
                     GTE, cop0; later: dynarec (tcg_* spec) emitting WASM blocks
    gpu.ts         ← software rasterizer per polygon/line/sprite funcs
                     (flat3/4, gouraud3/4, textured3/4, innerloop* variants)
    cdrom.ts       ← CdromIoIrqFunc1/2, CdromDmaIrqFunc1/2, GetInt5errCode
    spu.ts, mdec.ts, timers.ts (rcnt_update), pad.ts (PAD_startPoll/Poll protocol)
    bios.ts        ← load_bios spec: 512KiB (0x80000) into psxBIOS; HLE later
    loader/        ← psexe.ts (load_psexe header+ram), cue.ts, chd.ts, pbp.ts, zip.ts
  ui/              ← React TS, mirrors extracted GTK blueprint (598 widgets)
    MainWindow, MenuFile/MenuCpu/MenuVideo/MenuSound/MenuNetplay,
    ConfigVideoCore (=window_config_videocore), ConfigGamepad, ConfigMemcard,
    Cheats (=runGSCodes surface), About
  state/           ← config keys identical to binary: BiosPath, BiosHLE, GPU*,
                     CpuOverclocking… (read_configfile/write_configuration spec)
  engine/          ← glue: file pickers → blob URLs → core; rAF loop; audio sink
```

## Low-RAM rules (evidence-based)
1. Native ePSXe holds ~20.7 MiB in fixed .bss globals → we mirror: ALL emu state in
   2–3 preallocated ArrayBuffers, allocated once. No per-frame JS allocation.
2. React never owns emulator state; UI subscribes to a small store (menu/settings +
   1 Hz status: fps, region, disc). Per-frame pixels go canvas←WASM/typed array,
   bypassing React entirely.
3. GPU texture/framebuffer cache with LRU eviction (their *Cache function family).
4. Save states = structured slices of the buffers → IndexedDB (zsave/zload spec).
5. Worker thread for core; main thread only UI (their GPU mt/soft-mt mode flags show
   the same thread-split design).

## UI parity
Blueprint: knowledge-base/ui-blueprint/epsxe-gtk-interface-extracted.ui
(same menus, same dialogs, same widget structure, same config keys; React-TS
components; dark GTK-like theme so it reads as ePSXe).

## Phases (each verifiable before next)
0. Skeleton: React app + memory.ts + config store + file loaders (ps-exe first —
   boots without BIOS! exactly like load_psexe does).
1. CPU interpreter + GTE + timers: boot a homebrew PS-X EXE → "Hello world" on canvas.
2. GPU software renderer (start flat3/flat4/sprite) → real graphics.
3. CDROM + MDEC + SPU + BIOS path (real BIOS 512KiB supplied by user; HLE optional).
4. Dynarec tier (tcg_* spec → emit WASM per translated block).
5. UI parity pass across all 598-widget dialogs; netplay/cheats last (spec exists).

## Verification (per phase)
- Phase 0–1: run homebrew PS-X EXE in headless test → compare PC/REG trace.
- Phase 2: render known framebuffer → pixel hash.
- Always: memory profile (heap snapshot) must stay flat after warmup (low-RAM proof).
