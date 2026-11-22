# ePSXe 2.0.5 Linux x64 — binary RE map
Target: `apps/epsxe_x64` · ELF x86-64, stripped · sha256(zip) `60a99db5…ca99`
BuildID `be2e59a8…10291d0f` · Ghidra 12.2 backend (install in progress at first pass)

## Static evidence (strings + ELF sections, pre-decompile)
.text 0x42a320 · .rodata 0x5642c0 · .data 0x80fa80 · .bss 0x90e660 (globals live here)

### CPU engine (what we mirror as core choice)
- `Dynarec (fast)` vs `Interpreter (Accurate)` — radio menu items → two JIT tiers.
- `CPUOverclocking` x1 / x1.5 / x2 / x3 / x4 menu.
- `BiosHLE = %d` — **HLE BIOS mode exists** (can boot without a real BIOS dump).

### Plugin ABI (PSEmu plugin wrappers embedded in the binary)
GPU wrapper exports seen as call tables:
`init, open, close, shutdown, dmaChain, readData(Mem), readStatus, writeData(Mem),
writeStatus, writeEVRAM, getLibInfos, getMode, getVRAM, getFlipEGL, gpuFreeze, keypressed,
makeSnapshot, getScreenPic(Set), getOptionGL(Fixes), glBindTextureVirtual, addVertex`
→ the web port equivalent: one WASM module per subsystem behind a fixed ABI (GPU/SPU/PAD/CDROM).

### Peripherals
- `PAD1_/PAD2_` `startPoll, Poll, bios_Poll, query, MultitapPort, AFButton1..4, AFFreq1..4`
  (poll protocol + multitap + autofire), driver `Init/Open/Close/Shutdown`.

### Disc/file formats supported natively
`.CUE .BIN .ISO .IMG .PBP .ecm` + compressed `zip / 7z` ("Loading Single CUE",
"Loading Multi CUE/BIN", "Compressed: %d", "error loading .exe file in pll/zip" → EXE loading too).

### Native deps (de-risked in WASM by design)
`libSDL-1.2, libSDL_ttf-2.0, libncurses.so.5, libgtk-3, libcurl.so.4, libcrypto.so.1.0.0`
→ all become browser APIs (canvas/WebGL, WebAudio, Gamepad API, fetch) in the rebuild.

## Mapping rules for the React-TS rebuild (no repo, no copied code)
| native concept | web rebuild concept |
|---|---|
| function | TS method / WASM export |
| global in .bss | typed state store slice |
| PSEmu plugin wrapper | engine adapter interface (GPU/SPU/PAD/CDROM) |
| GTK menu toggles | React settings panel state |
| file loaders (cue/zip/7z/pbp) | TS parsers + WASM decompressors |

## TODO when Ghidra lands
- decompile: config parser (`BiosPath = %s` format-user), plugin loader, main loop,
  cdrom IRQ funcs (`CdromIoIrqFunc1/2`, `CdromDmaIrqFunc1/2`, `CdromGetInt5errCode`).
- enumerate all functions, sample pseudocode per subsystem, record in this file.
