# PS1-in-Browser — Project Notes

## Goal
Serve a static web page where the **browser is the emulator engine**. Zero emulation on our server. Our only job: the frontend downloads/loads successfully for visitors.

## Why not ePSXe itself
- ePSXe is closed-source native (Win32 / Linux / Android). No WASM port exists, no source to compile.
- `apps/epsxe_x64` (v2.0.5, sha256 `60a99db5…ca99`) is kept **as a reference only** (docs, compat behavior), not as the engine.
- Its own docs (`apps/docs/`) state the BIOS rule we must honor.

## Chosen engine: EmulatorJS (RetroArch `pcsx_rearmed` core via CDN)
- GPL3, free CDN, works from GitHub Pages / any static host.
- Core fetched client-side → CPU work happens in the visitor's browser.
- Alternative: RetroArch Web Player, DuckStation WASM (more work, no CDN).

## Legal boundaries (hard rules)
- **Never host the PS1 BIOS** (`bios.bin`, `scph*.bin`). Copyrighted. User supplies their own (drag & drop). ePSXe's own docs: legal only if you own the console and it isn't packaged/sold.
- **Never host ROMs.** User loads their own `.bin/.cue/.chd/.pbp`.
- No uploads: files stay in browser memory / IndexedDB (save states). Nothing touches our server.

## Technical constraints
- CDN must send CORS headers (EmulatorJS CDN does).
- `pcsx_rearmed` WASM: playable on modern desktops; low-end phones may struggle. WebGL renderer recommended.
- CHD supported; cue+bin pairs should be dropped together (or zip).
- Save states persist in browser IndexedDB per-origin.

## Deliverables
- `apps/index.html` — player page (drag&drop BIOS + game, EmulatorJS embed).
- `assets/` — branding only.
- Hosting: GitHub Pages or any static CDN. "Download success" = page loads and core fetch works.

## Verification plan
1. `python3 -m http.server` locally (CORS-safe origin, not `file://`).
2. Open page, drop a BIOS + a homebrew/test PS1 ISO (e.g. a homebrew demo disc), confirm boot + audio + gamepad.
3. Check network tab: only CDN requests, no POST/upload from the page.
