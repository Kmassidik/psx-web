/**
 * CDROM controller (Phase 3): mirrors ePSXe CdromIoIrqFunc1 (INT3 ack)
 * / CdromIoIrqFunc2 (INT5 complete) / CdromGetInt5errCode (error latch).
 * No-disc, no real I/O; sector data is fed by the caller via setSectorData().
 *
 * UNVERIFIED (timing approximation): 1 exec() step == one interrupt-class
 * latency bucket. Constants below were chosen so every command needs exactly
 * two exec() calls to settle (ack -> complete); real hardware delays vary by
 * command and disc. Delay documentation is per-response in each handler.
 */
export class Cdrom {
  /**
   * Hardware register window 1F801800..1F80180F, 14 bytes used.
   * 0: index/status  1: (resp FIFO via r2 doorbell)
   * 2: parameter FIFO (w)  3: response FIFO (r)
   * 4: interrupt enable  5: interrupt flag  6: (diag)  7: ctrl
   */
  readonly regs = new Uint8Array(16);
  /** Current sector payload (2352 raw bytes) for ReadN/ReadS delivery. */
  readonly sectorBuffer = new Uint8Array(2352);
  /** IRQ hook; line 2 = CDROM (INT1 per no$psx IRQ naming). */
  irqFire: (line: number) => void = () => {};

  // --- internal FIFOs (regs 2/3 are the hardware doorbells) ---
  private paramFifo: number[] = [];
  private respFifo: number[] = [];
  private respQueue: Array<{ code: number; data: number[] }> = [];
  private cmd = -1; // active command opcode, -1 = none
  private ready = false; // second response queued for next exec()
  private errCode = 0; // CdromGetInt5errCode latch: last error cause
  private lastStat = 0; // cached status byte
  private reading = false; // ReadN/ReadS active
  private seekTarget = 0; // last SeekL/SeekP target (LBA / MSF-decoded)
  private modeReg = 0; // SetMode value
  private motorOn = false; // spindle state
  private idDone = false; // GetID finished
  private readDelay = 0; // steps until next sector (UNVERIFIED: 1)

  reset(): void {
    this.regs.fill(0);
    this.sectorBuffer.fill(0);
    this.paramFifo.length = 0;
    this.respFifo.length = 0;
    this.respQueue.length = 0;
    this.cmd = -1;
    this.ready = false;
    this.errCode = 0;
    this.lastStat = 0x18; // no disc, motor off
    this.reading = false;
    this.seekTarget = 0;
    this.modeReg = 0;
    this.motorOn = false;
    this.idDone = false;
    this.readDelay = 0;
  }

  // --- host / memory-mapped interface ---

  /** Write to 1F801800 (index) or 1F801801 (command doorbell). */
  write(addr: number, value: number): void {
    if (addr === 0) {
      this.regs[0] = value & 7;
    } else if (addr === 1) {
      this.command(value & 0xff);
    }
  }

  /** Read from 1F801800 (status/index) or 1F801801 (response pop). */
  read(addr: number): number {
    if (addr === 0) {
      let s = this.regs[0]! & 7;
      if (this.paramFifo.length === 0) s |= 0x20; // EMPT
      if (this.paramFifo.length === 16) s |= 0x40; // FULL
      if (this.respFifo.length > 0) s |= 0x40; // DRQSTS
      return s;
    }
    const v = this.respFifo.shift() ?? 0xff;
    if (this.respFifo.length === 0) this.regs[0]! &= ~0x40;
    return v;
  }

  /** Write to 1F801802 (parameter FIFO push). */
  writeParam(value: number): void {
    if (this.paramFifo.length < 16) this.paramFifo.push(value & 0xff);
  }

  /** Feed one raw 2352-byte sector from the host (disc image layer). */
  setSectorData(data: Uint8Array): void {
    this.sectorBuffer.set(data.subarray(0, 2352));
    if (this.reading && !this.ready) {
      this.ready = true; // INT1 + DRQ stat on next exec()
      this.readDelay = 0;
    }
  }

  // --- command issue (from write(1)) ---

  private command(op: number): void {
    if (op >= 0x02 && op <= 0x05) {
      // Int3 / Int2 / Int1 / Int0: immediate single response
      this.lastStat = op === 0x02 ? 0x18 : this.lastStat;
      this.pushResponse(op, [this.lastStat]);
      return;
    }
    this.cmd = op;
    this.wantComplete = true;
    this.doubleInt = false;
    this.paramFifo.length = 0; // per no$psx: command clears param FIFO
  }

  /**
   * Advance the state machine one step.
   * Timing model (UNVERIFIED): 1 step == one IRQ latency bucket.
   * Each normal command: step1 -> INT3 (ack), step2 -> INT5 (complete).
   * Sector delivery after ReadN: step -> INT1 (data), then INT5 (complete).
   */
  exec(): void {
    if (this.ready) {
      // Sector arrived: INT1 + DRQ first, INT5 complete next step.
      this.lastStat |= 0x20; // DRQ
      this.pushResponse(1, [this.lastStat]);
      this.ready = false;
      this.respQueue.push({ code: 5, data: [this.lastStat & ~0x20] });
      return;
    }
    if (this.cmd < 0) return;
    const op = this.cmd;
    this.cmd = -1;

    switch (op) {
      case 0x01: { // GetStat
        // Delays (UNVERIFIED): ack ~1 step, complete ~1 step.
        this.pushResponse(3, [this.lastStat]);
        this.respQueue.push({ code: 5, data: [this.lastStat] });
        break;
      }
      case 0x06: { // ReadN
        this.motorOn = true;
        this.reading = true;
        this.seeking = false;
        this.lastStat = 0x02; // SPIN motor on
        // ack (1 step), then INT5 "reading" (1 step); data arrives later
        // via setSectorData -> exec -> INT1.
        this.pushResponse(3, [0x02]);
        this.respQueue.push({ code: 5, data: [0x02] });
        break;
      }
      case 0x09: // Pause (bonus; keep simple, same shape as SeekP)
      case 0x0a: { // Init
        this.reading = false;
        this.motorOn = false;
        this.lastStat = 0x18;
        // Delays (UNVERIFIED): ack 1 step, complete 1 step.
        this.pushResponse(3, [0x18]);
        this.respQueue.push({ code: 5, data: [0x18] });
        break;
      }
      case 0x0b: { // SeekL: param = 4-byte LBA
        const l = this.paramFifo;
        this.seekTarget =
          ((l[0] ?? 0) | ((l[1] ?? 0) << 8) | ((l[2] ?? 0) << 16)) | 0;
        this.seeking = true;
        this.motorOn = true;
        this.lastStat = 0x42; // SEEK|SPIN
        this.pushResponse(3, [0x42]);
        this.respQueue.push({ code: 5, data: [0x02] });
        break;
      }
      case 0x0c: { // SeekP: param = 3-byte MSF
        const l = this.paramFifo;
        this.seekTarget =
          ((l[0] ?? 0) * 75 + (l[1] ?? 0)) * 75 + ((l[2] ?? 0) | 0);
        this.seeking = true;
        this.motorOn = true;
        this.lastStat = 0x42;
        this.pushResponse(3, [0x42]);
        this.respQueue.push({ code: 5, data: [0x02] });
        break;
      }
      case 0x0e: { // SetMode: param = 1-byte mode flags
        this.modeReg = this.paramFifo[0] ?? 0;
        this.pushResponse(3, [this.lastStat]);
        this.respQueue.push({ code: 5, data: [this.lastStat] });
        break;
      }
      case 0x19: { // Test
        this.pushResponse(3, [this.lastStat]);
        this.respQueue.push({ code: 5, data: [this.lastStat] });
        break;
      }
      case 0x1a: { // GetID
        // No disc: per no$psx, INT5 error 80h (no disc) with stat 0x18.
        // Delays (UNVERIFIED): ack 1 step, error complete 1 step.
        this.pushResponse(3, [0x18]); // ack ok
        this.errCode = 0x80;
        this.respQueue.push({ code: 5, data: [0x18, 0x00, 0x00, 0x80] });
        break;
      }
      case 0x1e: { // ReadTOC
        this.pushResponse(3, [0x02]);
        this.respQueue.push({ code: 5, data: [0x02] });
        break;
      }
      default: { // unsupported opcode -> error response
        this.errCode = 0x40; // bad command (UNVERIFIED code choice)
        this.pushResponse(5, [0x18, 0x00, 0x00, 0x40]);
        break;
      }
    }
  }

  // --- internals ---

  private pushResponse(code: number, data: number[]): void {
    this.respFifo.length = 0;
    for (const b of data) this.respFifo.push(b);
    this.regs[3] = code & 0x0f; // response FIFO index byte per doc
    this.regs[5] = code & 0x0f; // interrupt flag: cause
    this.regs[4] = this.regs[4]! | (code & 0x0f); // interrupt enable set
    this.irqFire(2); // CDROM IRQ line
    if (code === 5) this.doubleInt = true;
  }

  /** CdromGetInt5errCode mirror: read last error cause (0 = none). */
  getErrorCode(): number {
    return this.errCode;
  }

  /** True after a completed GetID (diagnostic helper). */
  get idComplete(): boolean {
    return this.idDone;
  }
}
