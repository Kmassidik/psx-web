# HLE BIOS Reference — PCSX-ReARMed `libpcsxcore/psxbios.c` (4845 lines)

Ground truth for our BIOS-free boot. Key structures & mechanisms, all in KUSEG RAM:

## Table of Tables (guest-visible at fixed addresses)
| Addr | Meaning |
|------|---------|
| 0x0100 | ExCB ptr (exception callback chains) |
| 0x0108 | PCB ptr |
| 0x0110 | TCB ptr |
| 0x0120 | EvCB ptr (event descriptors) |
| 0x0200 | A-table (256 fn ptrs, filled with trap addrs 0x1010+i*4) |
| 0x0874 | B-table (same via 0x2010+i*4; B5b special at 0x43d0) |
| 0x0674 | C-table (0x3010+i*4) |
| 0x74a8 | pad/card IRQ chain entry (next, h1=0x49bc, h2=0x4a4c) |
| 0x74b8 | PAD_IRQR_ENA (pad reads on vblank IRQ when set) |
| 0x74c4 | PAD_DR_DST (game's button destination) |
| 0x74c8/0x74d0 | pad in/out buffers (2 pads) |
| 0x7570/0x7598 | pad raw read buffers |

## The trap mechanic (how HLE survives game patching)
- Vector 0xA0/0xB0/0xC0 = single `HLEOP(hleop_a0/b0/c0)` word — custom R3000A opcode (0x3b<<26 | op).
- A/B/C tables filled with pointers to TRAP regions (0x1010+, 0x2010+, 0x3010+) each containing HLEOP(a0t/b0t/c0t). Dispatch derives fn from (pc-trapbase)/4-1, so games that patch table entries or jump directly into the table still route to HLE. If entry != trap addr → game installed a custom handler → softCall(entry) executes guest code.
- hleA0/B0/C0: call = $t1 & 0xff (kernel ABI: $t1 = fn# for A/B/C).

## Pad/card interrupt model (THE bit we're missing)
- InitPAD(B/12): zeroes in/out buffers, writes pad/card chain {0x74a8: next=0,h1=0x49bc,h2=0x4a4c}, sets 0x74b8 per arg.
- StartPAD(B/13): Deq+Enq chain at prio 2 into ExCB, unmasks IRQ0 in I_MASK(0x1074)|=1, PAD_ACK_VBL=1, SR|=0x401.
- InitCARD(B/4a): writes same chain, CARD_ISLOT=0, STATUS1/2=1, PAD_IRQR_ENA=a0, FlushCache.
- StartCARD(B/4b): Deq+Enq prio 2, I_MASK|=1, PAD_ACK_VBL=1, CARD_IRQR_ENA=1.
- PAD_init(A/15=0x2000000x form): InitPAD(bufs 0x7570/0x7598 len 0x22)+StartPAD, stores dst.
- _bu_init(A/70): CARD_HLVL_FN=0 + DeliverEvent(F0000011,04), DeliverEvent(F4000001,04).
- VBLANK IRQ → hleExcPadCard1 (chain prio 2): if PAD_IRQR_ENA: PADpoll both pads into in-buffers (button bytes), if PAD_DR_DST: PAD_dr copies to game buffer; ack vblank; if CARD_IRQR_ENA: card_vint_handler.
- Exception dispatch (psxBiosException): walks ExCB 4 chains → chain nodes {next, verifier, handler} — verifier first, if v0!=0 run handler. Chains: prio0=cdrom(defaults at 0x6da8+0x91d0/0x91e0 w/ BIOS code ptrs 0xbfc0506c etc. — for HLE they're the hleExc0_x traps), prio1=vblank/timers (0x19c8/0x18bc...), prio2=pad/card, prio3=DMA(0x2458).
- SysEnqIntRP(C/02 prio, chain): inserts chain at head of ExCB[prio<<3]. Deq removes.

## Bootstrap register convention (psxBiosSetupBootState)
v0=1 v1=4 a0=1 a2=0 a3=0x2a t2=0x2d t4=0x23 t5=0x2b t6=0xa0010000 s0=0xa000b870 gp kept; game entry via ExecRet.

## What our kernel must add (mapped to our code)
1. A/B/C HLE dispatch must survive ANY call path: decode table+fn from $t1 ABI (not stub PC), and keep our stub PCs as traps.
2. A(0x02) read, A(0x44) FlushCache=ret0, A(0x55)+A(0x70) _bu_init (DeliverEvent F0000011,04 + F4000001,04), A(0x71) CdInit (DeliverEvent F0000003,0x20 after reset).
3. B(0x12) InitPAD / B(0x13) StartPAD / B(0x16) PAD_dr / B(0x15) PAD_init — full ReARMed semantics with OUR joypad as the data source; PAD_IRQR_ENA flag + 0x74a8 chain.
4. C(0x01) SysEnqIntRP / C(0x02) — we have Enq; verify Deq too.
5. Interrupt dispatch: on VBLANK run prio-2 chain first (pad reads), then prio1 (vblank events); on DMA/CDROM lines run their chains.
