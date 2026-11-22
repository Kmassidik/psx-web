# psx-web (working title)

PlayStation-1 emulator for the browser. Built from scratch (React + TypeScript,
Bun toolchain). No emulator repository reused; behavioral spec derived from a
reverse-engineering pass of a shipped PS1 emulator binary (see knowledge-base/).

- Browser is the engine: all emulation runs client-side (TS interpreter now,
  WASM dynarec tier later). Server = static files only.
- User supplies BIOS/ROM at runtime; nothing copyrighted is hosted here.
- Low-RAM design: emulator state in preallocated ArrayBuffers mirroring the
  reference binary's fixed memory layout; React never touches per-frame data.

Layout: apps/ (React-TS player) · knowledge-base/ (RE evidence, build plan,
extracted UI blueprint) · assets/ (branding placeholder).
