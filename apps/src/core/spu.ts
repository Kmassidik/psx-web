/**
 * SPU (Phase 3): 24 voices, ADPCM decode, gauss pitch, ADSR envelopes, mixing.
 * Mirrors the reference SPU core minus reverb (skipped this phase, later
 * ticket) and minus pitch modulation / noise / sweep envelopes.
 *
 * regs = Uint16Array(0x200), u16 registers at byte offsets from 0x1F801C00:
 *   0x0000-0x017F voice 0-23 blocks          0x0180/182 MVOLL/MVOLR
 *   0x0188/18A KON key-on (write)            0x018C/18E KOF key-off (write)
 *   0x0190/192 PMON (unused)                 0x0194/196 NON (unused)
 *   0x0198/19A EON (unused)                  0x019C/19E ENDX status
 *   0x01A4 IRQ address, 0x01A6 transfer addr, 0x01A8 data port
 *   0x01AA ATTR (control), 0x01AE STATX (status)
 * Voice block n (8 u16s at n*8): VOLL,VOLR,PITCH,SSA,ADSR1,ADSR2,ENVX,LSAX.
 */
import { SpuVoice, applyVolume, directVolume } from "./spu-voice";

export const SPU_RAM_SIZE = 0x80000; // 512 KiB

export class Spu {
  readonly regs = new Uint16Array(0x200);
  readonly ram = new Uint8Array(SPU_RAM_SIZE);
  readonly voices: SpuVoice[] = [];
  /** Per-voice ENDX latch; mirrored into regs ENDX0/ENDX1 (0x009C/0x009E). */
  private endx = 0;
  private transferAddr = 0;
  irqFire: (line: number) => void = () => {};
  /** SPU interrupt: set ATTR bit6 to enable, psx-spx "Voice Interrupt". */
  irqAddr = 0;
  private irqEnabled = false;
  private irqPending = false;

  constructor() {
    for (let n = 0; n < 24; n++) this.voices.push(new SpuVoice(n, this.regs, n * 8));
    this.regs[0x1ae] = 0x001c; // STATX power-on default
  }

  reset(): void {
    this.regs.fill(0);
    this.ram.fill(0);
    this.regs[0x1ae] = 0x001c;
    this.endx = 0;
    this.transferAddr = 0;
    this.irqAddr = 0;
    this.irqEnabled = false;
    this.irqPending = false;
  }

  /** ---- Register access (u16 offsets from 0x1F801C00) ---- */

  read(offset: number): number {
    switch (offset) {
      case 0x019c: return this.endx & 0xffff; // ENDX0
      case 0x019e: return (this.endx >>> 16) & 0x00ff; // ENDX1
      case 0x01ae: return (this.regs[0x1ae]! & 0xff80) | (this.irqEnabled ? 0x40 : 0) |
        (this.irqPending ? 0x40 : 0) | (this.regs[0x1aa]! & 0x3f); // STATX
      default: return this.regs[offset < 0x180 ? offset >>> 1 : offset]!;
    }
  }

  write(offset: number, value: number): void {
    value &= 0xffff;
    switch (offset) {
      case 0x0188: // KON voices 0-15
        this.applyKeyOn(value, 0);
        return;
      case 0x018a: // KON voices 16-23
        this.applyKeyOn(value & 0x00ff, 16);
        return;
      case 0x018c: // KOF voices 0-15
        this.applyKeyOff(value, 0);
        return;
      case 0x018e: // KOF voices 16-23
        this.applyKeyOff(value & 0x00ff, 16);
        return;
      case 0x019c: // ENDX0/1: writes clear the latched bits
        this.endx &= ~value;
        this.syncEndx();
        return;
      case 0x019e:
        this.endx &= ~(value & 0xff) << 16;
        this.syncEndx();
        return;
      case 0x01a4: // IRQA
        this.irqAddr = (value << 3) & 0x7ffff;
        this.regs[offset] = value;
        return;
      case 0x01aa: // ATTR: bit6 enables the SPU interrupt
        this.irqEnabled = (value & 0x40) !== 0;
        if (!this.irqEnabled) this.irqPending = false;
        this.regs[offset] = value;
        return;
      case 0x01a6: // TSA: transfer start address (8-byte units)
        this.regs[offset] = value;
        this.transferAddr = (value << 3) & 0x7ffff;
        return;
      case 0x01a8: { // data port: each halfword write increments current addr
        this.ram[this.transferAddr] = value & 0xff;
        this.ram[(this.transferAddr + 1) & 0x7ffff] = value >>> 8;
        this.transferAddr = (this.transferAddr + 2) & 0x7ffff;
        return;
      }
      default:
        this.regs[offset < 0x180 ? offset >>> 1 : offset] = value;
    }
  }

  private applyKeyOn(mask: number, firstVoice: number): void {
    for (let b = 0; b < 16 && firstVoice + b < 24; b++) {
      if ((mask & (1 << b)) !== 0) {
        const voice = this.voices[firstVoice + b]!;
        voice.keyOn(this.ram);
        this.endx &= ~(1 << (firstVoice + b)); // key on clears ENDX
      }
    }
    this.syncEndx();
  }

  private applyKeyOff(mask: number, firstVoice: number): void {
    for (let b = 0; b < 16 && firstVoice + b < 24; b++) {
      if ((mask & (1 << b)) !== 0) this.voices[firstVoice + b]!.env.keyOff();
    }
  }

  private syncEndx(): void {
    this.regs[0x019c] = this.endx & 0xffff;
    this.regs[0x019e] = (this.endx >>> 16) & 0x00ff;
  }

  /** ---- Voice block access (voice n, register index 0-7) ---- */

  readVoice(n: number, reg: number): number {
    if (reg === 6) return this.voices[n]!.env.level; // ENVX is live level
    return this.regs[n * 8 + reg]!;
  }

  writeVoice(n: number, reg: number, value: number): void {
    if (reg === 6) return; // ENVX is read-only
    this.regs[n * 8 + reg] = value & 0xffff;
  }

  /** ---- Key on/off API mirroring the register semantics ---- */

  /** keyOn(channelMask): voice key-on = write 1 to the voice's ch bit. */
  keyOn(channelMask: number): void {
    this.applyKeyOn(channelMask & 0xffff, 0);
    this.applyKeyOn((channelMask >>> 16) & 0xff, 16);
  }

  keyOff(channelMask: number): void {
    this.applyKeyOff(channelMask & 0xffff, 0);
    this.applyKeyOff((channelMask >>> 16) & 0xff, 16);
  }

  /** ---- Data transfer (manual write; DMA drives this via the port) ---- */

  /** Write halfwords to the data port starting at the transfer address. */
  writeDataPort(words: number[] | Uint16Array): void {
    for (let i = 0; i < words.length; i++) this.write(0x01a8, words[i]!);
  }

  /** ---- Mixing ---- */

  /** Advance the SPU by `cycles` CPU cycles (SPU ticks at cy/768 = 44100Hz). */
  tick(cycles: number): void {
    const samples = Math.floor(cycles / 768);
    for (let i = 0; i < samples; i++) this.stepSample(this.mixL, this.mixR);
  }

  /**
   * Mix `length` output samples into outL/outR at 44100Hz stereo float
   * [-1..1]. Per voice: ADPCM decode -> gauss interpolate -> volume (L/R)
   * -> ADSR envelope multiply; main volume after voice sum. Reverb: not
   * applied this phase (documented skip).
   */
  mix(outL: Float32Array, outR: Float32Array): void {
    const length = Math.min(outL.length, outR.length);
    for (let i = 0; i < length; i++) {
      this.stepSample(this.mixL, this.mixR);
      outL[i] = this.mixL[0]!;
      outR[i] = this.mixR[0]!;
    }
  }

  /** One 44.1kHz sample: clocks voices, decodes ADPCM, mixes to float. */
  private stepSample(mixL: Float32Array, mixR: Float32Array): void {
    const spuOn = (this.regs[0x1aa]! & 0x8000) !== 0;
    const unmuted = (this.regs[0x1aa]! & 0x4000) !== 0;
    let accL = 0;
    let accR = 0;
    // Voices always clock (hardware never stops ADPCM decode); ATTR only
    // gates the mixed output.
    for (const voice of this.voices) {
      voice.env.step();
      voice.clock(this.ram);
      if (voice.endx) {
        this.endx |= 1 << voice.n;
        this.syncEndx();
      }
      if (!spuOn || !unmuted) continue;
      const sample = voice.sample();
      voice.sweepTick();
      // Final voice volume: (ENVX * VOLX) >> 15 (psx-spx), with the sweep
      // envelope carrying VOLX in sweep mode.
      const env = voice.env.level;
      const vL = applyVolume(applyVolume(sample, env), voice.sweepLevelL);
      const vR = applyVolume(applyVolume(sample, env), voice.sweepLevelR);
      accL += vL;
      accR += vR;
      this.checkVoiceIrq(voice);
    }
    accL = Math.max(-0x8000, Math.min(0x7fff, accL));
    accR = Math.max(-0x8000, Math.min(0x7fff, accR));
    accL = applyVolume(accL, directVolume(this.regs[0x0180]!)); // MVOLL
    accR = applyVolume(accR, directVolume(this.regs[0x0182]!)); // MVOLR
    // Fire a latched SPU IRQ once (edge), before clearing the flag.
    if (this.irqPending) {
      this.irqPending = false;
      this.irqFire(9); // SPU IRQ line
    }
    mixL[0] = accL / 0x8000;
    mixR[0] = accR / 0x8000;
  }

  /** SPU interrupt: trigger when a voice reads the block at IRQA. */
  private checkVoiceIrq(voice: SpuVoice): void {
    if (!this.irqEnabled || this.irqPending) return;
    const blockAddr = (this.regs[0x01a4]! << 3) & 0x7ffff;
    if (voice.addr === blockAddr) this.irqPending = true;
  }

  /** Per-sample scratch so mix() allocates nothing per frame. */
  private mixL = new Float32Array(1);
  private mixR = new Float32Array(1);
}
