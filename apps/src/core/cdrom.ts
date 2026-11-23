/**
 * CDROM controller (Phase 3). Mirrors ePSXe's CdromIoIrqFunc1 / CdromIoIrqFunc2
 * / CdromGetInt5errCode shape: one response per interrupt, second responses
 * queued until the first is acknowledged, error latch for INT5.
 *
 * Spec reference: no$psx CDROM chapters (I/O ports, command summary,
 * mainloop/responses, status commands). No disc, no real I/O; sector data is
 * fed by the caller via setSectorData().
 *
 * UNVERIFIED (timing): 1 exec() step == one interrupt latency bucket. Per
 * command delay documentation lives in the exec() handler for that command.
 */
export class Cdrom {
  /**
   * Register window 1F801800..1F80180F. Semantics per no$psx I/O ports:
   * 0 index/status   1 cmd(w)/resp+data(r)   2 param(w)/data(r)   3 req/ien/ifl
   * 4-7 audio volume + apply (unimplemented, kept for window completeness)
   */
  readonly regs = new Uint8Array(16);
  /** Current raw 2352-byte sector payload (host-fed disc image). */
  readonly sectorBuffer = new Uint8Array(2352);
  /** IRQ hook; line 2 = CDROM interrupt. */
  irqFire: (line: number) => void = () => {};

  // FIFOs
  private paramFifo: number[] = [];
  private respFifo: number[] = []; // 16-byte response buffer
  private lastResp: number[] = []; // last response for pad/restart reads
  private respIdx = 0; // read position while padding/restarting
  // Queued responses: first delivered immediately (pushResponse), second on
  // ack (no$psx Mainloop/Responses: INT queue is one-deep per class).
  private queued: Array<{ int: number; data: number[] }> = [];
  // Active command pipeline
  private cmd = -1; // opcode awaiting the next ack, -1 = none
  private cmdParams: number[] = []; // params latched at command issue
  private busy = false; // 1F801800 bit7 transmission busy
  // Drive state
  private stat = 0x00; // cached status byte (bit1..7 per no$psx)
  private modeReg = 0; // Setmode value
  private seekErr = 0; // second-response seek error (04h)
  private errCode = 0; // last error byte (CdromGetInt5errCode latch)
  private reading = false; // ReadN/ReadS active (data INT1 stream)
  private dataPending = false; // sector latched, INT1 owed on next exec
  private sectorProvider?: (lba: number) => Uint8Array | undefined;
  private dataOffset = 0;
  private sectorReady = false;
  private secondPending = false; // second response queued for next exec
  private motorOn = false;
  private shellOpen = false; // stat bit4 sticky
  private idDone = false; // GetID completed
  private seekTargetLba = 0;
  private seekTargetMsf = [0, 0, 0];

  reset(): void {
    this.regs.fill(0);
    this.sectorBuffer.fill(0);
    this.paramFifo.length = 0;
    this.respFifo.length = 0;
    this.lastResp.length = 0;
    this.respIdx = 0;
    this.queued.length = 0;
    this.cmd = -1;
    this.cmdParams.length = 0;
    this.busy = false;
    this.stat = 0x08; // IdError (GetID denied: no disc) per no$psx GetID table
    this.modeReg = 0;
    this.seekErr = 0;
    this.errCode = 0;
    this.reading = false;
    this.dataPending = false;
    this.dataOffset = 0;
    this.sectorReady = false;
    this.secondPending = false;
    this.motorOn = false;
    this.shellOpen = false;
    this.idDone = false;
    this.seekTargetLba = 0;
    this.seekTargetMsf = [0, 0, 0];
  }

  constructor() {
    this.reset();
  }

  // --- memory-mapped interface (1F801800..03, addr = offset) ---

  /** Bus write. addr 0: index; 1: command; 2: param fifo; 3: req/ien/ifl. */
  write(addr: number, value: number): void {
    const v = value & 0xff;
    switch (addr & 3) {
      case 0:
        this.regs[0] = v & 3; // only bit0-1 are R/W
        break;
      case 1:
        this.command(v);
        break;
      case 2:
        if (this.paramFifo.length < 16) this.paramFifo.push(v);
        break;
      case 3: {
        const idx = this.regs[0]! & 3;
        if (idx === 0) {
          // Request register: bit7 BFRD reloads data fifo (no-op: no DMA yet)
        } else if (idx === 1) {
          this.regs[4] = v; // Interrupt Enable
        } else if (idx === 2) {
          this.regs[6] = v; // audio volume mirror slot
        } else {
          // Index3: bit5 apply volume (no audio yet); bit6 clears param fifo
          if (v & 0x40) this.paramFifo.length = 0;
        }
        break;
      }
    }
  }

  /** Bus read. addr 0: index/status; 1: response pop; 2: data fifo; 3: ifl. */
  read(addr: number): number {
    switch (addr & 3) {
      case 0: {
        const idx = this.regs[0]! & 3;
        let s = idx;
        if (!this.busy) s |= 0x80; // BUSYSTS 0=ready
        if (this.paramFifo.length === 0) s |= 0x08; // PRMEMPT
        if (this.paramFifo.length === 16) s |= 0x10; // PRMWRDY(=not full)
        if (this.respFifo.length === 0) s |= 0x20; // RSLRRDY(0=empty->1?)
        // no$psx: bit5 "Response fifo empty (0=Empty)" -- set when EMPTY is 0,
        // i.e. bit5=1 means response available.
        if (this.respFifo.length > 0) s |= 0x20;
        if (this.dataPending) s |= 0x40; // DRQSTS data available
        return s;
      }
      case 3: {
        const idx = this.regs[0]! & 3;
        if (idx === 1) return this.regs[5]!; // IFL
        if (idx === 0) return 0;
        return this.regs[6]!; // audio volume/apply mirror
      }
      case 1:
      case 2: {
        // Response fifo read. no$psx: after the
        // last real byte the buffer is 00h-padded to the end of 16 bytes,
        // then restarts at the first response byte.
        if (this.respFifo.length > 0) {
          const b = this.respFifo.shift()!;
          this.respIdx = this.lastResp.length - this.respFifo.length - 1;
          return b;
        }
        if (this.lastResp.length === 0) return 0;
        this.respIdx = (this.respIdx + 1) % 16;
        return this.respIdx < this.lastResp.length
          ? this.lastResp[this.respIdx]!
          : 0;
      }
    }
    return 0; // unreachable
  }

  setSectorProvider(provider: (lba: number) => Uint8Array | undefined): void {
    this.sectorProvider = provider;
    this.motorOn = true;
    this.stat = (this.stat & ~0x08) | 0x02;
  }

  /** Feed the next requested sector after DMA consumed the previous one. */
  pump(): void {
    if (!this.reading || this.dataPending || this.sectorReady || !this.sectorProvider) return;
    const data = this.sectorProvider(this.seekTargetLba);
    if (!data) return;
    this.seekTargetLba++;
    this.setSectorData(data);
  }

  /** Feed one raw 2352-byte sector (host disc-image layer). */
  setSectorData(data: Uint8Array): void {
    this.sectorBuffer.set(data.subarray(0, 2352));
    this.stat &= ~0x08; // data arriving => disc present, IdError cleared
    this.dataOffset = 0;
    this.sectorReady = true;
    if (this.reading && !this.dataPending) {
      this.dataPending = true; // INT1 + DRQ owed on next exec()
    }
  }

  /** Read one little-endian word from the current sector's user data. */
  readData32(): number {
    const start = (this.modeReg & 0x08) !== 0 ? 12 : 24;
    const size = (this.modeReg & 0x08) !== 0 ? 2340 : 2048;
    if (!this.sectorReady || this.dataOffset >= size) return 0;
    const offset = start + this.dataOffset;
    this.dataOffset += 4;
    if (this.dataOffset >= size) this.sectorReady = false;
    return (this.sectorBuffer[offset]! |
      (this.sectorBuffer[offset + 1]! << 8) |
      (this.sectorBuffer[offset + 2]! << 16) |
      (this.sectorBuffer[offset + 3]! << 24)) >>> 0;
  }

  /** Explicit latch for tests / fast sector pump. */
  latchSector(): void {
    this.dataPending = true;
  }

  // --- command handling ---

  private command(op: number): void {
    // no$psx: if an INT is pending, the command is not executed yet. We do not
    // latch it (UNVERIFIED: hardware latches one command); the caller must
    // acknowledge and re-issue.
    if (this.cmd !== -1 || this.queued.length > 0 || (this.regs[5]! & 0x07) !== 0)
      return;
    this.busy = true; // command transmission busy until first response
    this.cmdParams = this.paramFifo.splice(0); // command consumes the FIFO
    this.cmd = op;
    this.exec(); // first response goes out immediately per no$psx
  }

  /**
   * Advance the state machine one step.
   *
   * Timing model (UNVERIFIED): 1 step == one IRQ latency bucket.
   * Command issue -> exec -> FIRST response (INT3, or INT5 on error).
   * SECOND response (INT2/INT5) -> next exec() after INT3 ack, or immediately
   * on the exec() after the command if nothing blocks (documented per case).
   * ReadN/ReadS data INT1 -> next exec() after setSectorData.
   */
  exec(): void {
    // 1. pending data INT1 wins (Read stream), only with no INT pending
    if (
      this.dataPending &&
      this.queued.length === 0 &&
      !this.busy &&
      (this.regs[5]! & 0x07) === 0
    ) {
      this.dataPending = false;
      this.stat = (this.stat & ~0xe0) | 0x20 | (this.motorOn ? 0x02 : 0); // Read
      this.pushResponse(1, [this.stat]);
      return;
    }
    // 2. queued second response (only when no INT is pending/acknowledged)
    if (
      this.secondPending &&
      this.queued.length > 0 &&
      !this.busy &&
      (this.regs[5]! & 0x07) === 0
    ) {
      const q = this.queued.shift()!;
      this.secondPending = false;
      this.pushResponse(q.int, q.data);
      return;
    }
    // 3. execute the latched command
    if (this.cmd === -1) return;
    const op = this.cmd;
    this.cmd = -1;
    this.busy = false;
    const p = this.cmdParams;

    switch (op) {
      case 0x01: { // Getstat: INT3(stat); resets shell-open flag on read
        // Delay: UNVERIFIED, ~instant on hardware.
        const s = this.stat;
        this.shellOpen = false;
        this.stat &= ~0x10;
        this.pushResponse(3, [s]);
        break;
      }
      case 0x02: { // Setloc amm,ass,asect
        this.seekTargetMsf = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
        const bcd = (value: number) => ((value >>> 4) * 10 + (value & 0x0f));
        this.seekTargetLba =
          (bcd(p[0] ?? 0) * 60 + bcd(p[1] ?? 0)) * 75 + bcd(p[2] ?? 0);
        this.pushResponse(3, [this.stat]);
        break;
      }
      case 0x03: { // Play (CD-DA)
        this.motorOn = true;
        this.stat = 0x80 | 0x02; // Play + motor
        this.pushResponse(3, [this.stat]);
        break;
      }
      case 0x04: // Forward
      case 0x05: { // Backward
        this.pushResponse(3, [this.stat]);
        break;
      }
      case 0x06: // ReadN
      case 0x1b: { // ReadS
        this.motorOn = true;
        this.reading = true;
        // stat: motor on, no Read-bit yet until seek completes (no$psx
        // Status: "Read/Play won't get set until after Seek completion").
        // The "second response" of Read is the INT1 data stream itself
        // (no$psx Mainloop: ReadN -> INT3(stat), INT1(stat), datablock),
        // so nothing is queued here; sectors arm INT1 via setSectorData.
        this.pushResponse(3, [0x02]);
        break;
      }
      case 0x07: { // MotorOn
        const already = this.motorOn;
        this.motorOn = true;
        const s = this.stat | 0x02;
        this.stat = s;
        this.pushResponse(3, [s]);
        // Delay: UNVERIFIED (spin-up, hardware ~1s).
        this.queueSecond(already ? 5 : 2, already ? [s, 0x20] : [s]);
        break;
      }
      case 0x08: { // Stop: bit1 cleared in second response
        const s0 = this.stat & ~0x20;
        this.motorOn = false;
        this.reading = false;
        this.pushResponse(3, [s0]);
        const s1 = s0 & ~0x02;
        this.stat = s1;
        // Delay: UNVERIFIED (magnetic brakes, hardware ~1s).
        this.queueSecond(2, [s1]);
        break;
      }
      case 0x09: { // Pause
        const s0 = this.stat;
        this.reading = false;
        this.pushResponse(3, [s0]);
        const s1 = s0 & ~0x20; // Read bit cleared
        this.stat = s1;
        // Delay: UNVERIFIED (hardware: head settle).
        this.queueSecond(2, [s1]);
        break;
      }
      case 0x0a: { // Init: mode=20h per no$psx, motor on
        this.modeReg = 0x20;
        this.motorOn = true;
        this.reading = false;
        const s0 = this.stat | 0x02;
        this.pushResponse(3, [s0]);
        const s1 = s0; // motor spinning, ready
        this.stat = s1;
        // Delay: UNVERIFIED (hardware: drive standby sequence).
        this.queueSecond(2, [s1]);
        break;
      }
      case 0x0b: // Mute
      case 0x0c: // Demute
        this.pushResponse(3, [this.stat]);
        break;
      case 0x0d: { // Setfilter file,channel
        this.pushResponse(3, [this.stat]);
        break;
      }
      case 0x0e: { // Setmode
        this.modeReg = p[0] ?? 0;
        this.pushResponse(3, [this.stat]);
        break;
      }
      case 0x0f: { // Getparam: stat,mode,null,file,channel
        this.pushResponse(3, [this.stat, this.modeReg, 0x00, 0x00, 0x00]);
        break;
      }
      case 0x10: { // GetlocL (8 bytes from current sector header)
        // Sector header/subheader: bytes 12..19 of the raw 2352 sector.
        const hdr = Array.from(this.sectorBuffer.subarray(12, 20));
        this.pushResponse(3, hdr);
        break;
      }
      case 0x11: { // GetlocP (8 bytes subchannel Q, BCD; zeros: no disc)
        this.pushResponse(3, [0, 1, 0, 0, 0, 0, 0, 0]);
        break;
      }
      case 0x12: { // SetSession
        this.pushResponse(3, [this.stat]);
        this.queueSecond(2, [this.stat]);
        break;
      }
      case 0x13: { // GetTN: stat,first,last (BCD; no disc -> 00,00)
        this.pushResponse(3, [this.stat, 0x00, 0x00]);
        break;
      }
      case 0x14: { // GetTD track: stat,mm,ss (BCD; no disc -> 00,00)
        this.pushResponse(3, [this.stat, 0x00, 0x00]);
        break;
      }
      case 0x15: { // SeekL (target = prior Setloc, per no$psx)
        this.motorOn = true;
        const s0 = this.stat | 0x40 | 0x02; // Seek + motor
        this.stat = s0;
        this.pushResponse(3, [s0]);
        const s1 = s0 & ~0x40; // seek done, motor on
        this.stat = s1;
        // Delay: UNVERIFIED (hardware: physical seek, tens of ms..seconds).
        this.queueSecond(2, [s1]);
        break;
      }
      case 0x16: { // SeekP
        this.motorOn = true;
        const s0 = this.stat | 0x40 | 0x02;
        this.stat = s0;
        this.pushResponse(3, [s0]);
        const s1 = s0 & ~0x40;
        this.stat = s1;
        this.queueSecond(2, [s1]); // Delay: UNVERIFIED, same as SeekL
        break;
      }
      case 0x19: { // Test sub_function
        const sub = p[0] ?? 0xff;
        if (sub === 0x20) {
          // Get cdrom BIOS date/version (yy,mm,dd,ver). UNVERIFIED: values
          // chosen as the commonly reported controller date (1994-12-xx).
          this.pushResponse(3, [0x94, 0x09, 0x19, 0xc2]);
        } else if (sub <= 0x05 || (sub >= 0x10 && sub <= 0x1a)) {
          this.pushResponse(3, [this.stat]);
        } else {
          this.errCode = 0x10; // invalid sub_function
          this.pushResponse(5, [0x10 | 0x01, 0x10]);
        }
        break;
      }
      case 0x1a: { // GetID
        const s = this.stat;
        this.pushResponse(3, [s]);
        this.idDone = true;
        if (this.sectorProvider) {
          // Licensed NTSC-U disc: stat, 00, 20, 00, "SCEA".
          this.queueSecond(2, [s, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41]);
        } else {
          this.errCode = 0x40;
          this.queueSecond(5, [0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        }
        break;
      }
      case 0x1c: { // Reset: INT3(stat), no completion INT (SW delays 1/8s)
        this.modeReg = 0;
        this.motorOn = false;
        this.reading = false;
        this.pushResponse(3, [this.stat & ~0x20]);
        break;
      }
      case 0x1e: { // ReadTOC: INT3(late-stat) + INT2(stat)
        const s0 = this.stat | 0x02; // spin-up
        this.pushResponse(3, [s0]);
        const s1 = s0;
        this.stat = s1;
        // Delay: UNVERIFIED (hardware: TOC read, ~1s).
        this.queueSecond(2, [s1]);
        break;
      }
      default: { // invalid command -> INT5(stat|1, 40h), params NOT removed
        this.errCode = 0x40; // Invalid command (no$psx error byte 40h)
        this.paramFifo.unshift(...this.cmdParams); // per no$psx caution note
        this.pushResponse(5, [(this.stat | 0x01) & 0xff, 0x40]);
        break;
      }
    }
  }

  // --- internals ---

  private queueSecond(int: number, data: number[]): void {
    this.queued.push({ int, data });
    this.secondPending = true;
  }

  /** Deliver a response now: load FIFO, set IRQ flag, raise CDROM IRQ. */
  private pushResponse(int: number, data: number[]): void {
    this.respFifo = data.slice(0, 16);
    this.lastResp = data.slice(0, 16);
    this.respIdx = 0;
    this.regs[5] = int & 0x07; // Interrupt Flag read value (1F801803 idx1)
    this.regs[4] = this.regs[4]! | 0x1f; // IEN default: all set
    this.irqFire(2); // CDROM IRQ line
    if (int === 5) {
      // Error response: stat bit0/2 set in data[0], latch error byte.
      if ((data[0] ?? 0) & 0x01) this.errCode = data[1] ?? 0;
      this.stat |= 0x01;
    }
  }

  /** Acknowledge pending INT(s): write value to 1F801803h.Index1. */
  ack(value: number): void {
    if (value & 0x07) {
      this.regs[5] = 0;
      this.respFifo.length = 0;
    }
  }

  /** CdromGetInt5errCode mirror: last error byte (00h = none). */
  getErrorCode(): number {
    return this.errCode;
  }

  /** Diagnostic: GetID has completed. */
  get idComplete(): boolean {
    return this.idDone;
  }

  /** Diagnostic: Setmode register (Init sets 20h). */
  get mode(): number {
    return this.modeReg;
  }
}
