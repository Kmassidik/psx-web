# TODO — PSX Web

Detailed execution plan for turning the current emulator checkpoint into a reliable browser PlayStation emulator. This file is a plan only; completing a task requires its acceptance criteria, tests, and browser verification.

## Current checkpoint

- Docker UI is available at `http://localhost:5174`.
- 3Xtreme reaches `FE.EXE` → `GAME.EXE`; the loading screen transitions to MISSION after the boot fixes.
- 3Xtreme reaches a real MISSION screen and accepts controller input; a race is not verified, so do not describe it as playable.
- The BIOS-free/HLE route is selected. A real BIOS remains optional and user-supplied.
- Latest full-suite checkpoint: 407 tests passing and TypeScript clean; repeatable browser E2E also passes.
- RCNT MMIO and handler timer waits are fixed; extended runs transfer full CD sectors without the previous invalid control flow.
- Game images and BIOS files stay local and ignored. Emulation remains client-side.
- Source files should remain below 600 lines; split modules by responsibility instead of growing monoliths.

## Working rules

- Work in priority order unless a later task is explicitly requested.
- Reproduce a failure before changing emulator behavior; preserve the failing trace or test.
- Fix the first incorrect hardware/software observable, not a downstream symptom.
- Do not add game-specific boot bypasses, frame patches, or forced program-counter jumps.
- Every behavioral fix needs the narrowest regression test that fails without the fix.
- After each completed task: run `bun test` and `bunx tsc --noEmit` from `apps/`, verify the affected browser surface, and commit only when both gates pass.
- Update this file and `README.md` when observable status changes.
- Never commit disc images, BIOS dumps, extracted game data, memory dumps containing them, or copyrighted reference assets.

---

## Phase 0 — Reproducible 3Xtreme diagnostics

### [x] 0.1 Add a deterministic commercial-boot smoke runner

**Goal:** Reproduce the current red-loading-bar state without manual browser uploads or temporary `/tmp` scripts.

**Work:**
- Add a development-only runner under `apps/src/dev/` or a documented test utility that accepts a local MDF path.
- Reuse the production `Machine`, MDF provider, ISO reader, and browser-equivalent `FE.EXE` → `GAME.EXE` sequence.
- Report slice count, cycles, PC, recent branches, active CDROM command, interrupt flags, DMA channels, GPU display area, and nonblack-pixel count.
- Keep large logs opt-in and bound trace buffers to fixed sizes.
- Ensure normal unit tests never require a commercial game image.

**Acceptance:** One documented command reproduces the same loading-bar state and prints enough state to compare two runs deterministically.

### [x] 0.2 Add bounded boot checkpoints and state comparison

**Goal:** Locate the first divergent or stalled operation instead of comparing only final PCs.

**Work:**
- Capture compact checkpoints at CDROM commands, event callbacks, executable transitions, DMA completions, and display-mode changes.
- Include register/PC summaries and peripheral state, not full disc or VRAM dumps by default.
- Add comparison output that identifies the first differing checkpoint between two runs.
- Verify that checkpoint collection does not change emulation results.

**Acceptance:** Repeating the same boot produces identical checkpoints; an intentional test mutation is reported at its first affected checkpoint.

### [x] 0.3 Remove temporary production diagnostics

**Goal:** Keep useful diagnostics without polluting normal UI status or hot paths.

**Work:**
- Move temporary PC/FPS boot diagnostics behind a development/debug setting.
- Remove obsolete throwaway probes and duplicate logging after their behavior is covered by the smoke runner.
- Keep errors user-readable and retain enough information to diagnose loader failures.

**Acceptance:** Normal runs show clean status text; debug mode exposes equivalent diagnostic detail without changing emulation behavior.

---

## Phase 1 — Get 3Xtreme past loading

### [x] 1.1 Identify the exact loading-loop wait condition

**Goal:** Name the condition preventing progress beyond the red loading bar.

**Work:**
- Trace the loop around the stable `0x8011Bxxx` PC range and record the memory/peripheral values it polls.
- Classify the blocker as CDROM data/completion, event delivery, interrupt acknowledgement, DMA, timer/VSync, GPU status, or incorrect control flow.
- Verify whether sector reads and data-buffer draining continue, stop, or repeat unexpectedly.
- Do not change behavior until the failing wait condition and its expected transition are documented.

**Acceptance:** A short note identifies the exact instruction/loop, waited-on state, expected hardware transition, and first subsystem observably violating it.

### [x] 1.2 Correct the first identified boot defect

**Goal:** Implement the smallest general hardware/HLE fix required by Task 1.1.

**Work:**
- Fix the owning subsystem rather than skipping the game loop.
- Add a focused regression test using synthetic registers, memory, sectors, or commands.
- Check adjacent behavior affected by the same contract, including error and acknowledgement paths.
- Re-run the deterministic boot and compare checkpoints before and after the fix.

**Acceptance:** The new regression fails on the prior implementation, passes with the fix, and 3Xtreme advances beyond the previous wait condition without a wild fetch or forced state change.

### [ ] 1.3 Complete CDROM streaming and file-I/O semantics required by the game

**Goal:** Support repeated game asset loads after the initial executable boot.

**Work:**
- Validate ReadN/ReadS, Pause, Stop, Reset, Setloc, Seek, Setmode, Getloc, status, and error transitions against observed driver use.
- Verify INT1/INT2/INT3/INT5 sequencing, response FIFOs, parameter FIFO, BFRD/DRQ, sector draining, and driver acknowledgements.
- Confirm completion interrupts occur only when their required data/response conditions are met.
- Validate raw MDF sector mapping, Mode 2 forms, subheader handling, XA/file filtering, and 2340/2352/2448-byte sector paths used by supported loaders.
- Add multi-sector and interrupted-read tests, including back-to-back commands and retry behavior.

**Acceptance:** Synthetic CDROM tests cover success, retry, pause/stop, and error flows; repeated 3Xtreme asset reads complete without stale data, duplicate completion, or missing interrupts.

### [ ] 1.4 Validate event, IRQ, DMA, and timer interaction during loading

**Goal:** Ensure asynchronous game callbacks run at the correct time with preserved execution state.

**Work:**
- Trace event creation, enabling, delivery, callback return, and interrupt masking through the HLE kernel.
- Verify handler entry/exit preserves all interrupted execution state required by the callback ABI.
- Validate DMA direction, block/sync modes, channel priority, completion flags, and IRQ acknowledgement for channels used by the game.
- Check RCNT and VSync cadence against CPU cycles and ensure callbacks cannot recursively corrupt the active handler state.
- Replace broad wild-fetch suppression with precise exception/invalid-address behavior if the trace identifies a real control-flow defect.

**Acceptance:** Tests cover nested/adjacent event delivery and state restoration; 3Xtreme loads without depending on a broad address-range hack or skipped instructions.

### [ ] 1.5 Reach and verify the 3Xtreme title screen

**Goal:** Produce a recognizable title/menu frame rendered by the game.

**Work:**
- Run the complete production browser path in Docker.
- Wait through asset loading without injecting state or changing game memory.
- Capture the canvas and verify that it contains recognizable game artwork/text, not only the loading bar.
- Confirm the display area, framebuffer selection, cropping, and refresh behavior remain stable over multiple frames.

**Acceptance:** The Docker browser visibly shows the actual 3Xtreme title screen or main menu; status is still described as non-playable until input and gameplay are verified.

---

## Phase 2 — Input, menus, and real gameplay

### [ ] 2.1 Implement and verify the complete digital controller protocol

**Goal:** Make title/menu navigation reliable through the real pad interface.

**Work:**
- Verify JOY_TX/RX, baud, control, mode, status, interrupt, and controller select behavior.
- Implement the digital-pad response sequence, ACK timing, and disconnected-device behavior.
- Map keyboard and standard Gamepad API inputs to the documented PS1 button bits with active-low semantics.
- Prevent browser scrolling/default shortcuts while the game canvas owns input.
- Add protocol tests and browser checks for Start, X, directions, and simultaneous buttons.

**Acceptance:** The title menu responds predictably to each mapped control; protocol tests verify byte order, ACK/IRQ behavior, and release/re-press transitions.

### [ ] 2.2 Navigate from the title screen into a race

**Goal:** Demonstrate actual gameplay, not just a rendered menu.

**Work:**
- Use normal controller input to navigate menus and start the simplest available race.
- Record any new loading or runtime stall and fix its first incorrect subsystem behavior using the same diagnostic process.
- Verify player movement, opponent/track updates, camera changes, and HUD animation over multiple frames.
- Test pause/resume and returning to the menu if supported by the current boot path.

**Acceptance:** A real race begins and responds to steering/input with changing game-rendered graphics for at least several minutes without invalid execution or a frozen frame.

### [ ] 2.3 Add analog and vibration support where required

**Goal:** Complete controller behavior for games that require analog mode or rumble.

**Work:**
- Implement analog/dual-shock mode responses, axis scaling, mode switching, and configuration commands.
- Map standard gamepad axes with dead zones and calibration settings.
- Route supported vibration commands to Gamepad API actuators, with a safe no-rumble fallback.
- Add protocol tests for digital, analog, dual-shock, and disconnected states.

**Acceptance:** Analog controls and supported rumble work in the browser without breaking digital-only titles; unsupported hardware degrades without errors.

---

## Phase 3 — Display correctness and full-window presentation

### [x] 3.1 Correct PS1 display timing, framebuffer selection, and cropping

**Goal:** Render the game’s intended active picture at the correct native dimensions.

**Work:**
- Implement and validate GP1 display enable, reset, DMA direction, display mode, horizontal/vertical ranges, and display-area start.
- Model NTSC/PAL timing, interlace, width/height modes, and framebuffer page changes required by observed games.
- Ensure canvas presentation uses the active display rectangle rather than a fixed 640×480 assumption.
- Add tests for common 256/320/368/512/640-wide and 240/256/480/512-line configurations.

**Acceptance:** Golden tests and the browser show the correct active image without stretched coordinates, stale field selection, black borders caused by incorrect cropping, or fixed-size clipping.

### [x] 3.2 Add responsive fit, integer scaling, and full-screen controls

**Goal:** Use the available browser window while preserving the PS1 aspect ratio.

**Work:**
- Add Fit, Integer, and Stretch display modes; default to aspect-correct Fit.
- Scale the canvas to the largest size that fits the available window, accounting for menus and status bars.
- Add a Full Screen action using the browser Fullscreen API, with keyboard and menu entry points.
- Handle resize, device-pixel-ratio changes, fullscreen entry/exit, and orientation changes without reallocating emulator state.
- Keep fullscreen scaling separate from emulated resolution; CSS/canvas scaling must not claim increased internal detail.

**Acceptance:** At common desktop and mobile viewport sizes, the active game image fills the available area according to the selected mode, remains centered, and enters/exits fullscreen without distortion or a blank canvas.

### [x] 3.3 Add optional high internal-resolution rendering

**Goal:** Provide real increased geometric detail rather than enlarged native pixels.

**Work:**
- Add an explicit native/2×/4× renderer setting, disabled by default until validated.
- Scale polygon vertices and sampling rules correctly while retaining native VRAM semantics for framebuffer reads/writes, texture pages, CLUTs, masks, dithering, and DMA transfers.
- Define behavior for games that read back rendered VRAM; high-resolution state must not corrupt native PS1 memory.
- Add native/high-resolution golden comparisons for geometry, texturing, clipping, and display output.
- Measure CPU/GPU cost and expose an unsupported/fallback state when browser limits are exceeded.

**Acceptance:** 2×/4× rendering visibly increases geometric resolution without changing game logic, native VRAM readback, aspect ratio, or framebuffer-upload behavior; all native-renderer tests remain green.

### [ ] 3.4 Complete missing GPU commands and visual effects

**Goal:** Remove remaining rendering corruption in real titles.

**Work:**
- Audit all GP0/GP1 command families and variable-length packet consumption.
- Verify textured polygons, sprites, lines, semi-transparency, dithering, masks, texture windows, draw offsets, clipping, and color precision.
- Add golden images for observed 3Xtreme corruption before changing raster behavior.
- Check VRAM upload/download and DMA linked-list ordering against direct GP0 writes.

**Acceptance:** New golden tests cover each corrected command/effect, and the tested game scenes render without known missing geometry, flicker, wrong textures, or framebuffer artifacts.

---

## Phase 4 — Audio and timing

### [ ] 4.1 Connect accurate SPU timing to browser audio

**Goal:** Produce stable game audio without affecting emulation speed.

**Work:**
- Validate voice addressing, ADPCM decode, ADSR, pitch, volume, sweep, noise, reverb, IRQ, and SPU DMA against focused tests.
- Transfer audio through a bounded queue to WebAudio/AudioWorklet without per-frame React updates or unbounded allocations.
- Handle browser autoplay restrictions with an explicit user gesture and clear muted/running state.
- Add buffer underrun/overrun metrics and recovery that does not discard emulator state.

**Acceptance:** Test tones and game audio play at the correct rate with no persistent crackling, runaway latency, or growing queues; mute/unmute and pause/resume behave predictably.

### [ ] 4.2 Establish a system-wide cycle scheduler

**Goal:** Replace ad hoc peripheral ticking with deterministic event scheduling.

**Work:**
- Define the CPU clock and relative GPU, CDROM, SPU, RCNT, DMA, SIO, and VSync rates.
- Schedule future events in a bounded queue and run due events deterministically.
- Preserve existing public behavior through integration tests while moving modules to the scheduler.
- Validate long-run drift and pause/resume behavior.

**Acceptance:** Peripheral ordering is deterministic across runs, timer/VSync tests pass at documented rates, and long runs do not accumulate avoidable timing drift.

### [x] 4.3 Pace emulation independently from display refresh

**Goal:** Run at the emulated console’s speed on 60/120/144 Hz displays and throttled tabs.

**Work:**
- Use elapsed time and the cycle scheduler rather than assuming one fixed instruction slice per animation frame.
- Separate emulation cycles, audio buffering, GPU presentation, and FPS measurement.
- Define bounded catch-up behavior after stalls; do not run an unlimited backlog.
- Pause cleanly on reset, file changes, and explicit user stop.

**Acceptance:** Game speed remains correct across supported refresh rates, FPS reporting reflects actual presented frames, and returning from a background tab does not freeze or fast-forward uncontrollably.

---

## Phase 5 — Remaining hardware correctness

### [x] 5.1 Finish MDEC decoding and DMA integration

**Goal:** Support FMV and compressed textures used by commercial games.

**Work:**
- Resolve the remaining MDEC test failures and document the accepted precision/rounding model.
- Validate quantization, IDCT, color conversion, block ordering, output depths, cropping, and signed chroma handling.
- Test MDEC input/output DMA, FIFO status, busy timing, and interrupted transfers.
- Add a small generated macroblock fixture and an integration decode test.

**Acceptance:** All MDEC unit tests pass, DMA integration is deterministic, and a representative game FMV/decode path produces valid frames without FIFO deadlock.

### [x] 5.2 Complete SIO, memory-card, and peripheral behavior

**Goal:** Support saving and other controller-port devices without stubs that falsely report success.

**Work:**
- Implement memory-card command sequences, checksums, sector reads/writes, formatting, ACK/IRQ behavior, and card absence.
- Store card images locally in IndexedDB with explicit export/import and no server upload.
- Validate two-controller ports and multitap only when a supported use case exists.
- Return accurate errors for unimplemented peripherals.

**Acceptance:** A game can create, read, modify, export, re-import, and reload a save; corrupted/absent cards produce defined behavior rather than silent data loss.

### [ ] 5.3 Refine BIOS-free HLE and optional real-BIOS execution

**Goal:** Support both paths without hiding missing functionality.

**Work:**
- Audit A0/B0/C0 calls used by tested titles and document semantics, return values, memory ownership, events, threads, and exception handling.
- Implement missing kernel structures only when driven by an observed program contract.
- Validate the optional 512 KiB user-supplied BIOS path separately from HLE.
- Keep HLE failures explicit in debug diagnostics; never substitute a fake successful result solely to advance a game.

**Acceptance:** HLE conformance tests cover implemented calls and state transitions; the same test program can run through the real-BIOS path where supported, with differences explained and tested.

---

## Phase 6 — Save states, configuration, and UI completion

### [x] 6.1 Implement complete, versioned save states

**Goal:** Save and restore deterministic execution across browser sessions.

**Work:**
- Define a versioned format containing CPU/COP0/GTE, RAM, scratchpad, VRAM, SPU voices/state, GPU parser state, CDROM queues, DMA, timers, MDEC, pads, scheduler, and HLE kernel state.
- Serialize pending queues and delayed operations, not only visible registers.
- Store states in IndexedDB with slot metadata, timestamp, game identity, format version, and integrity checks.
- Reject incompatible/corrupt states without modifying the running machine.

**Acceptance:** Save/load round-trips produce identical subsequent traces and frames across reloads; every newly added stateful subsystem is included in snapshot tests.

### [x] 6.2 Complete the ePSXe-style UI actions

**Goal:** Make every visible menu item functional or explicitly unavailable.

**Work:**
- Wire Run/Reset/Pause/Stop, disc and executable opening, video/gamepad/memory-card dialogs, fullscreen, save/load state, audio, and display options.
- Disable unsupported actions with explanatory text instead of leaving no-op controls.
- Add keyboard focus handling, accessible labels, modal focus trapping, and controller-friendly navigation where practical.
- Preserve the verified ePSXe visual layout while improving responsiveness.

**Acceptance:** Every enabled control performs its labeled action; keyboard and pointer flows work in Docker; dialogs preserve settings and close without stopping unrelated emulator state.

### [x] 6.3 Validate and persist user configuration safely

**Goal:** Keep settings predictable across reloads without persisting copyrighted content.

**Work:**
- Validate stored configuration versions and values, migrating known older formats.
- Persist non-sensitive preferences locally: display scale, audio volume, key mappings, renderer, and UI options.
- Keep BIOS/disc data session-local unless the user explicitly stores a memory card or save state.
- Provide Reset Defaults and clearly identify settings that require reset/reload.

**Acceptance:** Valid settings survive reloads; malformed/old settings fall back or migrate without crashing; no disc or BIOS bytes are uploaded or written into source control.

---

## Phase 7 — Performance and resource safety

### [x] 7.1 Move emulation to a worker with bounded transfer paths

**Goal:** Keep UI/input responsive during heavy emulation.

**Work:**
- Run the core scheduler in a dedicated Web Worker.
- Transfer frames and audio using reusable buffers or shared memory where supported.
- Define messages for boot, input, pause/reset, settings, save states, diagnostics, and fatal errors.
- Bound queues and handle worker failure/restart without duplicating execution.

**Acceptance:** Long frames do not block menu interaction; input reaches the worker deterministically; memory remains bounded and no frames/audio buffers accumulate without limit.

### [ ] 7.2 Eliminate avoidable hot-path allocation and copying

**Goal:** Maintain stable memory and predictable frame times.

**Work:**
- Profile CPU dispatch, GPU rasterization, DMA, disc reads, audio, and canvas presentation.
- Reuse preallocated typed arrays and fixed-size trace/queue storage.
- Avoid per-instruction objects, per-frame image copies, repeated sector allocations, and React updates for emulator state.
- Optimize only measured hotspots while retaining interpreter/dynarec parity.

**Acceptance:** Heap usage stabilizes after warm-up, allocation profiles show no avoidable per-instruction/frame growth, and behavior remains bit-identical in relevant tests.

### [x] 7.3 Validate dynarec as an optional optimized tier

**Goal:** Improve CPU throughput without changing semantics.

**Work:**
- Run interpreter and dynarec against identical programs, interrupts, exceptions, delay slots, memory accesses, and block invalidation cases.
- Verify self-modifying code and DMA writes invalidate affected translated blocks.
- Keep dynarec opt-in until commercial-game traces match the interpreter.
- Add benchmark results separately from correctness results.

**Acceptance:** Parity suites and deterministic boot checkpoints match; enabling dynarec changes performance only, not visible behavior or save-state compatibility.

---

## Phase 8 — Compatibility, release, and maintenance

### [ ] 8.1 Build a legal automated compatibility suite

**Goal:** Detect regressions using freely distributable tests and homebrew.

**Work:**
- Add homebrew/self-generated fixtures for CPU, GPU, CDROM, DMA, timers, MDEC, SPU, input, and save states.
- Record expected hashes/traces with provenance and version information.
- Keep commercial games in an optional local-only manual matrix; never require them in CI.
- Track boot, title, gameplay, audio, save, and known-issue status separately.

**Acceptance:** CI runs without copyrighted assets and catches subsystem regressions; the manual matrix reports evidence-backed status rather than a generic “working” label.

### [ ] 8.2 Verify production Docker and browser compatibility

**Goal:** Ensure the shipped app works outside the development machine.

**Work:**
- Build test/runtime images from a clean checkout.
- Verify current Chromium and Firefox, plus Safari where supported APIs are available.
- Test direct load, refresh, fullscreen, resize, file selection, keyboard/gamepad input, audio unlock, and IndexedDB persistence.
- Confirm no runtime dependency on local `/tmp` scripts, host file paths, or external emulation services.

**Acceptance:** The production container passes automated gates and documented browser smoke tests; unsupported browser features show actionable messages.

### [ ] 8.3 Update user and developer documentation

**Goal:** Make actual capabilities and operating instructions unambiguous.

**Work:**
- Update `README.md` with the current verified game state, supported formats, controls, display modes, audio requirements, and known limitations.
- Document development commands, Docker targets, diagnostic runner, test strategy, and legal asset rules.
- Keep architecture and hardware notes aligned with the implementation.
- Remove stale claims such as “done,” “playable,” or “high resolution” unless their acceptance criteria are satisfied.

**Acceptance:** A new developer can build, test, run, and diagnose the emulator from the documentation; user-facing status matches observed behavior.

### [ ] 8.4 Define the first playable release

**Goal:** Publish only after end-to-end behavior is demonstrated.

**Required evidence:**
- 3Xtreme reaches its title screen and enters a real race through normal input.
- Gameplay responds correctly for several minutes with stable graphics and no invalid execution.
- Display Fit/Integer/Stretch and fullscreen modes work at native internal resolution.
- Audio either works acceptably or is explicitly labeled unsupported.
- Save-state and memory-card claims match implemented, tested behavior.
- Full tests, TypeScript, production Docker build, and CI pass.
- No copyrighted game/BIOS assets are included in the repository or image.

**Acceptance:** Tag a release only when all required evidence is captured and remaining limitations are listed explicitly. High internal resolution, broader game compatibility, dynarec, and optional enhancements may follow in later releases unless requested as release blockers.

---

## Immediate execution order

1. **0.1–0.3:** make the current commercial boot reproducible and diagnosable.
2. **1.1–1.5:** find and fix the actual loading blocker; reach the title screen.
3. **2.1–2.2:** verify controller input and enter gameplay.
4. **3.1–3.2:** correct native display output and add full-window/fullscreen scaling.
5. **4.1–4.3:** stabilize audio and timing.
6. **Remaining phases:** expand correctness, performance, persistence, and compatibility.

A task is complete only when its observable acceptance criteria are met. A loading bar, a title screen, and playable gameplay are separate milestones and must not be conflated.
