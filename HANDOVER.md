# Handover — PS1 Web Emulator (psx-web)

**Date:** 2026-11-24
**Repo:** https://github.com/Kmassidik/psx-web (main @ `983a224`)
**Live:** `http://localhost:5174` (Docker: `psx-web-docker`)
**Target game:** 3Xtreme (`SBORRUS2.mdf`, local, git-ignored)

## What this is

A from-scratch PlayStation 1 emulator in TypeScript, browser-based, no BIOS ROM
required (HLE kernel). The game never leaves the machine — everything runs
client-side.

## Current state (honest)

| Layer | Status |
|-------|--------|
| CPU (branch/load delays, COP0, dynarec) | ✅ Complete |
| GTE (all 22 commands, cycles, IRGB/ORGB/SXYP) | ✅ Complete |
| GPU (textured polys, CLUT 4/8/15bpp, quads, lines, ordering table, semi-transparency) | ✅ Complete |
| GP0 decoder (108-opcode table, all VRAM transfers) | ✅ Complete |
| CDROM (sector delivery, MDF/CHD, FE→GAME handoff) | ✅ Complete |
| DMA/IRQ (level-follow DICR, all-priority chain dispatch, SIO line 7) | ✅ Complete |
| SPU (ADPCM, sweep envelopes) + MDEC (IDCT) | ✅ Complete |
| Controller (SIO0 ACK timing, keyboard bindings) | ✅ Complete |
| Save states, memory cards, worker isolation, UI | ✅ Complete |
| **HLE BIOS card-service state machine** | ❌ **The blocker** |

**551 tests green, tsc clean, CI passing.**

**Observable behavior:** game boots via FE.EXE → GAME.EXE, reaches the
end-of-frame render loop, executes its full init chain (InitCARD, StartPAD,
_bu_init all verified called and serviced). Display shows the game's loading
bar. The 3D race scene does not start.

## The one remaining blocker

The game's card library busy-waits on the BIOS's card-task service, which only
exists in the real BIOS ROM. Traced to the instruction level:

- Loop at `0x8011b150..b1a8`: decrements a timeout, calls three kernel-RAM
  card hooks (`jal 0x8011a79c` with `a0=0x800f9bcc`, then `0x8011b1bc(0)`,
  `0x8011b1cc(3,0)`), retries forever.
- Those hooks live at BIOS-RAM addresses (`0x800f9bcc` = card high-level
  function info) that the real BIOS populates during `InitCARD`/`StartCARD`.
- The game registers only its prio-2 pad/card chain (`C/02`); no prio-3 DMA
  handler exists because the BIOS never preset the default chains.

**Reference solution mapped:** PCSX-ReARMed `libpcsxcore/psxbios.c` (4,845
lines) implements this fully — extracted to
`knowledge-base/HLE-BIOS-REFERENCE.md` with the complete RAM layout
(`A_CARD_HLVL_FN 0x9f20`, `A_PAD_* 0x74a8-0x75d0`, ExCB chain model, PADpoll
semantics, `psxBiosCheckExe` timeout patch). The remaining work is
implementing the card service functions (`_card_info`, `_card_load`,
`_card_auto`) per that spec — well-defined, roughly 500-800 lines plus tests.

**Note:** ReARMed itself ships a bytecode patch (`psxBiosCheckExe`) that
detects this exact wait loop and fast-forwards it — proof it's a known HLE
BIOS limitation, not a mistake in our core. Our port of that patch (`git log`
— reverted in `5aadf73`) expired the timeout but the game then retries the
card op forever, confirming the card service itself must be implemented.

## Verified this session (2026-11-24)

- ePSXe 2.0.5 with BIOS dump (`~/.epsxe/bios/scph1001.bin`) renders the target
  race scene — screenshots at `/tmp/epsxe-*.png`
- DuckStation (flatpak) runs 3Xtreme fully playable on this desktop — the
  ground-truth reference for visual/audio parity
- Call census of our boot: all card/pad init calls fire correctly
  (`B/4a InitCARD:1, B/4b StartCARD:1, A/70 _bu_init:1, B/17 RTFE:2008`)
- 21k dead syscalls eliminated (canonical kernel tables fix)

## Key files

| Path | Role |
|------|------|
| `apps/src/core/syscall.ts` | HLE kernel — tables, pad/card, events |
| `apps/src/core/machine.ts` | Slice loop, IRQ dispatch, `runInterruptChain` |
| `apps/src/core/gpu.ts` / `gpu-raster.ts` | GP0 decode + rasterizer + OrderingTable |
| `apps/src/core/gte.ts` | Geometry transforms, `instructionCycles` |
| `apps/src/dev/commercial-boot.ts` | Deterministic MDF boot tracer (ground truth) |
| `knowledge-base/HLE-BIOS-REFERENCE.md` | **The resume-from-here spec** |
| `knowledge-base/RENDERING-BOTTLENECKS.md` | GPU pipeline notes |
| `books/index.html` | 21-chapter technical book on the whole emulator |

## Commands

```sh
cd apps && ~/.nix-profile/bin/bun test          # 551 tests
cd apps && ~/.nix-profile/bin/bunx tsc --noEmit # typecheck
# Boot trace (the acceptance gate):
cd apps && ~/.nix-profile/bin/bun run src/dev/commercial-boot.ts \
  ../assets-games/3extrime/SBORRUS2.mdf 20000 --fast
# Docker
docker build --target runtime -t psx-web . && \
  docker rm -f psx-web-docker && \
  docker run -d --name psx-web-docker --restart unless-stopped -p 5174:5173 psx-web
```

## Acceptance gate for "playable"

`commercial-boot` nonBlack significantly beyond 1428 AND pc progressing past
`0x80125734` (SPU init) into the render loop, then live browser verification:
upload MDF at `localhost:5174`, press Start/X, race scene renders and steers.

## Commit history this session

- `983a224` test: canonical GetB0Table address
- `5aadf73` feat: canonical kernel tables + pad driver BIOS layer
- `63a3e8c` chore: integrated rendering pipeline (GPU/GTE/GP0/MDEC/SPU)
- `988e2b0` feat: interrupt-chain dispatch fixes + SIO default service
- `832506a` feat: complete GPU rasterizer, GTE registers, GP0 decoder
- `ccca141` fix: DMA IRQ level-follow + device-level dispatch
