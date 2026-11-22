# Session log — overnight build

## Delivered (all committed + pushed, CI green)
- Phase 0/1: memory (exhaustive map), CPU interpreter (+ISA conformance),
  GTE (28 tests), rcnt, PS-X EXE loader, React shell, BIOS-free boot
  **proven in a real browser** (hand-assembled EXE → green canvas pixel).
- Phase 2: software rasterizer (flat/gouraud/textured, CLUT, blends, dither)
  + GP0 polygon word decoder + integration tests.
- Phase 3: CDROM controller (23 tests), SPU (27 tests, voices/ADPCM/gauss),
  MDEC (41 tests, AAN+real IDCT), DMA 7ch (20 tests), disc loaders
  (cue/iso 18, chd/pbp 16), WebAudio sink, BIOS load path — all wired into
  Machine bus + slice loop. Snapshot/restore full-state + replay equivalence.
- Phase 5 partial: config dialogs cloned from extracted GTK blueprint.
- Syscall HLE shield, CI workflow, README.

## In flight
- DynarecUnit: WASM tier (message sent with subset guidance + deadline).

## Known deferred (documented, not hidden)
- Real-game boot validation (needs user-supplied BIOS+disc at runtime).
- SPU reverb/PMON/noise, CDROM timing precision, texture windows, MDEC DMA
  handshake specifics — each has UNVERIFIED/spec-skip notes in code.

## Final tally at last green run
237 tests / 0 failures / 19 files, strict tsc clean, CI passing.
