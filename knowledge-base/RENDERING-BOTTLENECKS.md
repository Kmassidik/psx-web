# Rendering bottlenecks and remediation plan

## Current verified baseline

- `SBORRUS2.mdf` reaches MISSION and an animated race through the production browser.
- Start-only input accelerates and steers; pause/resume works.
- CD loading, controller packets, save states, and 407 tests are green.
- The remaining mismatch is rendering fidelity and timing, not boot or basic input.

WebGPU is a presentation technology, not an emulator-correctness shortcut. Fix GTE/GPU behavior first; consider WebGPU only after geometry and frames match hardware.

## Priority 1 — Incomplete GTE instruction set

### Evidence

`apps/src/core/gte.ts` currently handles only `RTPS`, `NCLIP`, `MVMVA`, `NCDS`, `NCDT`, `OP`, `SQR`, and `RTPT`. Common coordinate, color, and interpolation commands are missing.

### Why it matters

Missing commands prevent correct camera transforms, lighting, color setup, interpolation, and ordering-table output. The game can execute valid code while rendering incomplete or incorrect 3D scenes.

### Resolution used by other emulator developers

- Implement the complete real-opcode table rather than adding game-specific cases.
- Validate each command with independent expected values and public GTE test programs.
- Use existing timing-test results as behavioral references, not copied implementation code.

### References

- [PSX-SPX GTE specification](https://psx-spx.consoledev.net/geometrytransformationenginegte)
- [JaCzekanski PS1 test collection](https://github.com/JaCzekanski/ps1-tests)
- [DuckStation GTE timing tests](https://github.com/stenzek/duckstation/blob/master/src/core-tests/gte_timing_tests.cpp)
- [PSX-SPX GTE pipeline timings](https://psx-spx.consoledev.net/gtepipelinetimings)

## Priority 2 — GTE register semantics and timing

### Evidence

The GTE documentation specifies load delays, FIFO order, sign extension, saturation, fixed-point arithmetic, `sf`/`lm`, MVMVA selectors, and FLAG error bits. These are as important as the arithmetic itself.

### Why it matters

Correct math with incorrect delay or saturation still breaks geometry. Early register reads can consume stale values and produce static or exploded polygons.

### Resolution

- Model CFC2/MFC2 and GTE memory-transfer delays explicitly.
- Preserve SXY/SZ and RGB FIFO ordering, IRGB/ORGB conversion timing, and sign-extension rules.
- Add adversarial tests for overflow, negative coordinates, leading-zero operations, and back-to-back register accesses.

### References

- [PSX-SPX GTE register and delay rules](https://psx-spx.consoledev.net/geometrytransformationenginegte)
- [PSX-SPX GTE pipeline timings](https://psx-spx.consoledev.net/gtepipelinetimings)

## Priority 3 — Incomplete GP0 command and raster behavior

### Evidence

`apps/src/core/gpu.ts` handles common polygon/rectangle paths, but does not cover every line and rectangle variant or every rendering attribute.

### Why it matters

Menus and simple rectangles can render while textured track geometry, HUD lines, and effects remain wrong.

### Resolution

- Complete GP0 line, rectangle, textured, gouraud, semi-transparent, and DMA image paths.
- Decode packet lengths from the command bits instead of relying on common cases.
- Add command-by-command tests, including textured line and variable-size rectangle paths.

### References

- [PSX-SPX GPU specification](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/)
- [PSX-SPX render line commands](https://psx-spx.consoledev.net/ps1/gpu/render-line-commands)

## Priority 4 — Texture pages, CLUTs, and affine mapping

### Evidence

The renderer uses native VRAM textures, but texture-page, CLUT, window, and edge behavior still needs commercial-scene validation.

### Why it matters

A valid projection with wrong texture addressing produces a scene that looks materially different from ePSXe even though the frame is animated.

### Resolution

- Verify 4/8/15-bit texture modes, CLUT selection, texture-page coordinates, window wrapping, and transparent texels.
- Preserve PS1 affine mapping; do not substitute perspective-correct interpolation.
- Compare native VRAM and composed frame pixels for each texture path.

### References

- [PSX-SPX GPU and texture behavior](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/)
- [PSX-SPX perspective (in-)correct rendering](http://psx-spx.consoledev.net/ps1/gpu/misc)
- [Textures, TPages, and CLUTs tutorial](https://www.breck-mckye.com/psnoobsdk-docs/chapter1/3-textures.html)

## Priority 5 — Rasterization, shading, and primitive edges

### Evidence

The rasterizer has UNVERIFIED edge inclusion, texture-window rounding, and primitive decomposition behavior.

### Why it matters

Edge errors, dithering, semi-transparency, and diagonal triangulation can change visible output even when all GTE operations are correct.

### Resolution

- Match hardware span/edge inclusion and quad-to-triangle decomposition.
- Verify flat/gouraud shading, dithering, semi-transparent blending, and mask bits.
- Use deterministic pixel fixtures for triangles, quads, lines, clipping, and texture windows.

### References

- [PSX-SPX GPU specification](https://psx-spx.consoledev.net/graphicsprocessingunitgpu/)
- [PlayStation architecture: rasterisation and textures](https://www.copetti.org/writings/consoles/playstation)

## Priority 6 — DMA, IRQ, and handler scheduling

### Evidence

Current CDROM, DICR, VBlank, and PadCard paths work for this game, but several scheduler rules remain approximations. Device-priority dispatch was required to avoid CD starvation.

### Why it matters

A correct frame can be delayed, dropped, or shown at the wrong time. Handler timing also changes when input and CD DMA complete.

### Resolution

- Keep device IRQ delivery ahead of lower-priority PadCard work.
- Assert and deassert IRQ lines from the actual device completion state, not ad-hoc frame counters.
- Validate adjacent CD/DMA/VBlank completion and interrupt entry/exit state.

### References

- [PSX-SPX DMA channels](https://psx-spx.consoledev.net/dmachannels)
- [PSX-SPX interrupt handling](https://psx-spx.consoledev.net/interrupts)
- [PSX-SPX timer/root-counter documentation](https://psx-spx.consoledev.net/timers)

## Priority 7 — Presentation and frame pacing

### Evidence

Headless replay and live Chromium can differ because worker input is applied every run, RAF is throttled, or a headless tab pauses. These are host/presentation issues, not game-state differences.

### Why it matters

A working emulator can appear frozen or miss button edges when the browser scheduler is wrong.

### Resolution

- Keep cycle budgeting independent from presentation refresh rate.
- Apply each input snapshot once without resetting controller configuration.
- Verify with a visible, focused browser tab and compare frame hashes over time.

### References

- [WebGPU programming model and device timelines](https://gpuweb.github.io/gpuweb/explainer)
- [WebGPU API overview](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)

## Priority 8 — Audio and SPU/DMA timing

### Evidence

SPU output is running and browser E2E audio controls pass, but game-specific audio timing is still approximate.

### Why it matters

Audio DMA and SPU events can affect the same IRQ and frame schedule as graphics.

### Resolution

- Verify SPU DMA completion events, voice timing, ring occupancy, and underruns during actual gameplay.
- Keep the bounded audio ring and avoid host-thread work in the emulation hot path.

### References

- [PSX-SPX SPU documentation](https://psx-spx.consoledev.net/soundprocessingunitspu)
- [PSX-SPX DMA channels](https://psx-spx.consoledev.net/dmachannels)

## Implementation order

1. Complete GTE opcodes and register/timing semantics.
2. Add independent GTE command vectors and public test-program checks.
3. Complete GP0 line/rectangle and texture/CLUT paths.
4. Validate raster output against deterministic pixel fixtures and commercial frames.
5. Recheck DMA/IRQ and audio timing in the live game.
6. Only then evaluate a WebGPU presentation backend for performance.

## Acceptance criteria

- The expected ePSXe scene and the browser scene show equivalent geometry, textures, and HUD.
- Race animation and steering remain responsive for several minutes.
- No invalid execution, persistent handler truncation, frozen frame, or repeated CD retry loop.
- Full suite, TypeScript, production Docker, browser gameplay E2E, and CI remain green.
