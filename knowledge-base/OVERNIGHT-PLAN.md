# Overnight integration plan (chief-owned)

Agents in flight → integration order → gates.

## In-flight slices
| agent | delivers | integrates into |
|---|---|---|
| RasterUnit | gpu-raster.ts (poly fill) | gpu.ts gp0Param default branch |
| CdromUnit | cdrom.ts controller | machine.ts ports 0x1F801800+ |
| MdecUnit | mdec.ts (+tables) | machine.ts ports 0x1F801820+ |
| DiscUnit | loader/disc.ts cue/iso | future disc UI |
| DmaUnit | dma.ts (7 channels) | machine.ts (replaces ch2/ch6 stubs) |
| ChdPbpUnit | loader/chd.ts, pbp.ts | loader family |
| SpuUnit | spu.ts voices/ADSR | machine.ts ports 0x1F801C00+, WebAudio sink |
| DynarecUnit | dynarec/ (wasm tier) | cpu.ts dispatch (opt-in via config.Dynarec) |
| UiDialogUnit | ui/dialogs/* | MainWindow Options menu |

## Chief integration steps (after each agent lands)
1. Whole-suite green + tsc clean (CI gate).
2. Wire into machine.ts ports map — single owner: me.
3. Cross-slice property tests:
   - DMA→GPU linked-list fill (ch2 + gpu) — extend boot.test.ts.
   - DMA→CDROM read → sector buffer → INT flags.
   - Snapshot must include new module state (extend MachineSnapshot per slice).
4. Per-phase commit + push + CI green.

## Kernel/HLE boot path (chief, no agent needed)
- BIOS-free PS-EXE boot already works (Phase 1 e2e).
- Add exception dispatch hook: cpu.exception() → optional HLE handler map
  (A/B calls: 0xA0 file io stubs return success; 0xB0 return 0; 0xC0 return 0)
  so BIOS-dependent games get partial syscall surface without a BIOS dump.
- Real-BIOS path: load_bios spec (512 KiB into bios[]) — UI file drop for
  bios.bin reuses the EXE drop; store in config as Blob (never persisted to
  disk by us; sessionStorage blob URL only).

## Verification gates (per slice)
- Formal tests from agents must stay green on main after integration.
- New cross-module behavior → new tests in tests/integration-*.test.ts.
- CI (bun test + tsc) is the merge gate; failures block the checkpoint push.

## End state for tonight
- Phase 2 checkpoint: rasterizer + golden vectors.
- Phase 3 checkpoint: cdrom+mdec+dma+spu+disc+chd/pbp integrated, real-game
  boot path compiles (full audio/video timing validation may slip to a
  follow-up session — stated honestly in the commit).
- Phase 4 checkpoint: dynarec parity suite green behind config flag.
- Phase 5 checkpoint: dialogs merged, final docs.
