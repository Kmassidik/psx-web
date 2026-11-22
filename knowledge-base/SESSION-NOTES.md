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

## Final session results (Nortis milestone)

**Nortis (MIT Tetris clone) boots BIOS-free and runs real game code.**

Boot chain proven end-to-end:
1. PS-X EXE extracted from MODE2/2352 disc (sector 24, user offset 0)
2. loadExe → installHleVectors (A0/B0/C0 SYSCALL trampolines) → crt0 reg init
3. CPU runs crt0: BLTZ preamble, gfx/pad init via A/B calls, main()
4. VBLANK IRQ at ~60Hz drives VSync wait
5. Game reaches B_open disc-I/O call (font/texture file) and loops
   retrying — needs BIOS FS emulation over CDROM (Phase-3.5)

Key bugs found and fixed by formal verification:
- JR/JALR skipped the delay slot (interpreter)
- LW/SW load-delay was broken at block boundaries in the dynarec
- LW stray stack arg corrupted the wasm stack
- Unaligned LW/SW: BIOS handler emulates byte-wise, doesn't trap-and-halt
- CACHE op (0x27) = NOP on PS1
- Stub LUI table encoding → ADDIU
- Exception vector NOP-slide → return-past-EPC when no handler

## Honest limits
- Nortis reaches B_open and loops — BIOS FS over CDROM = next session
- Retail games need CDROM timing precision + DMA handshake
- GPU/SPU visually unverified for Nortis (B_open gates the graphics)
