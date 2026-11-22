/**
 * PS1 DMA controller — 7 channels (0..6), MMIO 0x1F801080+ch*0x10,
 * DPCR 0x1F8010F0, DICR 0x1F8010F4. Semantics per no$psx "DMA Transfers":
 * linked-list header word = nextAddr|words<<24 with 0xFFFFFF terminator,
 * sync modes 0=burst 1=block 2=linked-list (CHCR bits 17-18).
 *
 * regs layout: regs[ch*3+0]=MADR (base), regs[ch*3+1]=BCR (block),
 * regs[ch*3+2]=CHCR (ctrl). Execution is level-triggered: request() or a
 * ctrl write sets the START bit; run(bus) drains pending channels 0..6,
 * gated by each channel's enable nibble (bit3) in DPCR.
 *
 * Device hooks on DmaBus: ch0 MDECin→mdecIn, ch1 MDECout←mdecOut,
 * ch2 GPU→gpuWrite (linked-list AND block mode — block words are raw GP0
 * stream, same sink), ch3 CDROM←cdromRead, ch4 SPU = drain only, ch6 OTC
 * = RAM→RAM table build. readVram/writeVram are accepted for interface
 * compatibility with the machine-level bus; DMA itself only walks RAM.
 */

/** CHCR bit 24: start/busy. Cleared by run() when the transfer completes. */
const CHCR_START = 0x0100_0000;
/** CHCR bit 0: direction (1 = to RAM, 0 = from RAM) — contract convention. */
const CHCR_TO_RAM = 0x0000_0001;
/** CHCR bit 4: address step (0 = +4, 1 = -4). */
const CHCR_STEP_DEC = 0x0000_0010;
/** CHCR bits 9-10: sync mode (0 burst, 1 block, 2 linked-list). */
const CHCR_SYNC_SHIFT = 9;
const CHCR_SYNC_LIST = 2;
/** BCR word count 0 behaves as 0x10000 per no$psx. */
const BCR_ZERO_COUNT = 0x1_0000;
/** DMA addresses live in the 2 MiB RAM mirror, word aligned. */
const RAM_ADDR_MASK = 0x1f_fffc;
/** Linked-list / OTC next-pointer terminator. */
const LIST_END = 0x00ff_ffff;
/** DICR field masks. */
const DICR_STAT = 0x0000_007f; // per-channel status, write-1-clear
const DICR_ENABLE = 0x007f_0000; // per-channel enable, bits 16+ch
const DICR_MASTER_ENABLE = 0x0080_0000;
const DICR_MASTER_FLAG = 0x0100_0000;
const DICR_FORCE = 0x0200_0000;
/** DMA interrupt line into the IRQ controller. */
const IRQ_LINE = 3;

export interface DmaBus {
  readVram(addr: number): number;
  writeVram(addr: number, v: number): void;
  readRam(a: number): number;
  writeRam(a: number, v: number): void;
  mdecIn?(w: number): void;
  mdecOut?(): number;
  cdromRead?(): number;
  /** ch2 GPU sink: linked-list packets and block-mode GP0 words. */
  gpuWrite?(w: number): void;
}

export class Dma {
  /** Per-channel MADR/BCR/CHCR triplets: regs[ch*3+n], channels 0..6. */
  readonly regs = new Uint32Array(21);
  /** 0x1F8010F0: one nibble per channel, bit3 of nibble = enable. */
  dpcr = 0;
  /** 0x1F8010F4: status bits 0-6, enables 16-22, master enable/flag, force. */
  dicr = 0;
  /** Called on IRQ assert (line 3) when a completed channel is enabled. */
  raiseIrq: (line: number) => void = () => {};

  /** Mark a channel's transfer pending (CHCR START), as a ctrl write would. */
  request(channel: number): void {
    const ch = channel & 7;
    this.regs[ch * 3 + 2] = (this.regs[ch * 3 + 2]! | CHCR_START) >>> 0;
  }

  /** DPCR channel-enable nibble (bit ch*4+3). */
  enabled(channel: number): boolean {
    return ((this.dpcr >>> (channel * 4 + 3)) & 1) !== 0;
  }

  /** Drain all pending, DPCR-enabled channels (priority order 0..6). */
  run(bus: DmaBus): void {
    for (let ch = 0; ch < 7; ch++) {
      const ctrl = this.regs[ch * 3 + 2]!;
      if ((ctrl & CHCR_START) === 0 || !this.enabled(ch)) continue;
      if (ch === 6) this.runOtc(bus);
      else if (((ctrl >>> CHCR_SYNC_SHIFT) & 3) === CHCR_SYNC_LIST) this.runLinkedList(ch, bus);
      else this.runBlock(ch, bus);
      this.regs[ch * 3 + 2] = ctrl & ~CHCR_START;
      this.dicr |= 1 << ch;
      this.updateIrq();
    }
  }

  /** MMIO write for 0x1F8010F4: write-1-clear status, set enables/master/force. */
  writeDicr(v: number): void {
    this.dicr &= ~(v & DICR_STAT);
    this.dicr = (this.dicr & ~DICR_ENABLE) | (v & DICR_ENABLE);
    this.dicr |= v & DICR_MASTER_ENABLE; // master enable: write-1-set, sticky
    this.dicr = (this.dicr & ~DICR_FORCE) | (v & DICR_FORCE);
    this.updateIrq();
  }

  /** Master flag = (status & per-channel enables) | force; IRQ needs master enable. */
  private updateIrq(): void {
    const pending = (this.dicr & DICR_STAT) & ((this.dicr >>> 16) & DICR_STAT);
    if (pending !== 0 || (this.dicr & DICR_FORCE) !== 0) {
      this.dicr |= DICR_MASTER_FLAG;
      if ((this.dicr & DICR_MASTER_ENABLE) !== 0) this.raiseIrq(IRQ_LINE);
    } else {
      this.dicr &= ~DICR_MASTER_FLAG;
    }
  }

  /** Burst (sync 0) and block (sync 1): BCR words (× BCR blocks for sync 1). */
  private runBlock(ch: number, bus: DmaBus): void {
    const ctrl = this.regs[ch * 3 + 2]!;
    const bcr = this.regs[ch * 3 + 1]!;
    let words = bcr & 0xffff;
    if (words === 0) words = BCR_ZERO_COUNT;
    const blocks = ((ctrl >>> CHCR_SYNC_SHIFT) & 3) === 1 ? bcr >>> 16 : 1;
    const total = words * (blocks === 0 ? 1 : blocks);
    const step = (ctrl & CHCR_STEP_DEC) !== 0 ? -4 : 4;
    const toRam = (ctrl & CHCR_TO_RAM) !== 0;
    let addr = this.regs[ch * 3]! & RAM_ADDR_MASK;
    for (let i = 0; i < total; i++) {
      if (toRam) {
        let w = 0;
        if (ch === 1) w = bus.mdecOut?.() ?? 0;
        else if (ch === 3) w = bus.cdromRead?.() ?? 0;
        bus.writeRam(addr, w);
      } else {
        const w = bus.readRam(addr);
        if (ch === 0) bus.mdecIn?.(w);
        else if (ch === 2) bus.gpuWrite?.(w);
        // ch4 SPU / others without a hook: address still advances (drain).
      }
      addr = (addr + step) & RAM_ADDR_MASK;
    }
  }

  /** ch2 sync 2: header = nextAddr|words<<24, walk until 0xFFFFFF next. */
  private runLinkedList(ch: number, bus: DmaBus): void {
    let addr = this.regs[ch * 3]! & RAM_ADDR_MASK;
    for (let guard = 0; guard < 0x10_0000; guard++) {
      const head = bus.readRam(addr);
      const words = head >>> 24;
      for (let i = 0; i < words; i++) {
        addr = (addr + 4) & RAM_ADDR_MASK;
        bus.gpuWrite?.(bus.readRam(addr));
      }
      addr = head & 0x00ff_ffff;
      if (addr === LIST_END) break;
    }
  }

  /** ch6 OTC: reverse clear-texture table, last entry = terminator. */
  private runOtc(bus: DmaBus): void {
    let n = this.regs[6 * 3 + 1]! & 0xffff;
    if (n === 0) n = BCR_ZERO_COUNT;
    let addr = this.regs[6 * 3]! & RAM_ADDR_MASK;
    for (let i = 0; i < n; i++) {
      const next = i === n - 1 ? LIST_END : (addr - 4) & RAM_ADDR_MASK;
      bus.writeRam(addr, next);
      addr = (addr - 4) & RAM_ADDR_MASK;
    }
  }
}
