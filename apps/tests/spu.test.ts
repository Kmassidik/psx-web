import { describe, test, expect } from "bun:test";
import { Spu, SPU_RAM_SIZE } from "../src/core/spu";
import {
  SpuVoice, Adsr, decodeAdpcmBlock, gaussInterpolate, GAUSS, directVolume,
  sweepStep, sweepParams,
} from "../src/core/spu-voice";

/** u16 register offsets (from 0x1F801C00) inside a voice's 8-register block. */
const V_VOLL = 0, V_PITCH = 2, V_SSA = 3, V_ADSR1 = 4, V_ADSR2 = 5, V_LSAX = 7;

/** Sine-ish reference PCM, ADPCM-encoded with shift/filter chosen per test. */
function encodeSimpleFilter0(pcm: number[], shift: number): Uint8Array {
  const blocks = Math.ceil(pcm.length / 28);
  const out = new Uint8Array(blocks * 16);
  for (let b = 0; b < blocks; b++) {
    const base = b * 16;
    out[base] = shift; // filter 0
    out[base + 1] = b === blocks - 1 ? 0x03 : 0; // last block: end+repeat
    for (let i = 0; i < 28; i++) {
      const pcmIdx = b * 28 + i;
      if (pcmIdx >= pcm.length) break;
      const nib = Math.max(-8, Math.min(7, pcm[pcmIdx]! >> (12 - shift))) & 0x0f;
      const byteOff = base + 2 + (i >> 1);
      if ((i & 1) === 0) out[byteOff] = (out[byteOff]! & 0xf0) | nib;
      else out[byteOff] = (out[byteOff]! & 0x0f) | (nib << 4);
    }
  }
  return out;
}

describe("SPU ADPCM decode", () => {
  test("known nibbles with filter 0 decode to exact shifted samples", () => {
    // shift=3 -> each nibble decodes to nib<<9.
    const ram = new Uint8Array(16);
    ram[0] = 0x03; // shift=3, filter=0
    ram[1] = 0x00; // no loop flags
    ram[2] = 0x21; // LSBs first: sample0=1, sample1=2 (positive, not sign-extended)
    ram[3] = 0x97; // sample2=7, sample3=9 (-7 signed)
    const out = new Int16Array(28);
    decodeAdpcmBlock(ram, 0, 0, 0, out);
    expect(out[0]).toBe(1 << 9);
    expect(out[1]).toBe(2 << 9);
    expect(out[2]).toBe(7 << 9);
    expect(out[3]).toBe(-7 << 9);
    expect(out[4]).toBe(0);
  });

  test("filter 1 applies (60*old+32)/64 to previous block sample", () => {
    // First block: nibble 4, shift 12 -> sample = 4<<0 = 4
    const b1 = new Uint8Array(16);
    b1[0] = 0x0c; // shift=12, filter=0 -> nibble<<0
    b1[2] = 0x04; // sample0 = 4
    const d1 = new Int16Array(28);
    decodeAdpcmBlock(b1, 0, 0, 0, d1);
    expect(d1[0]).toBe(4);
    // Second block: filter 1, shift 12, nibble 0 -> 0 + (60*4+32)/64 = 4 (>>15 trunc)
    const b2 = new Uint8Array(16);
    b2[0] = 0x1c; // shift=12, filter=1
    b2[2] = 0x00;
    const d2 = new Int16Array(28);
    decodeAdpcmBlock(b2, 0, d1[0]!, 0, d2);
    expect(d2[0]).toBe((60 * 4 + 32) >> 6);
  });

  test("invalid shift 13-15 and filter >4 clamp like reference", () => {
    const ram = new Uint8Array(16);
    ram[0] = 0xfd; // shift=13 (invalid -> 9), filter=15 (clamped to 4)
    ram[1] = 0;
    ram[2] = 0x01; // sample0 nibble 1
    const out = new Int16Array(28);
    decodeAdpcmBlock(ram, 0, 0, 0, out);
    expect(out[0]).toBe(1 << 3); // shift decoded as 9 (nibble<<3), filter clamped to 4
  });

  test(" Crash Bandicoot 2 reference block decodes exactly", () => {
    // From jsgroth ps1-spu part 1: block bytes + expected 28 samples.
    const block = Uint8Array.from([
      0x48, 0x00, 0xd2, 0x4d, 0xef, 0xf0, 0xe3, 0x3c,
      0x1f, 0xed, 0xf4, 0x2f, 0x2e, 0xef, 0xe3, 0x13,
    ]);
    const expected = [
      343, 238, 84, 2, -90, -204, -304, -403, -434, -481, -573, -592, -606, -583,
      -590, -609, -543, -479, -419, -317, -242, -131, -38, 18, 118, 176, 273, 371,
    ];
    const out = new Int16Array(28);
    decodeAdpcmBlock(block, 0, 392, 465, out);
    for (let i = 0; i < 28; i++) expect(out[i]).toBe(expected[i]!);
  });

  test("loop flags: start updates LSAX, end jumps and mute forces release", () => {
    const spu = new Spu();
    // Block at 0: loop-start flag, one loud sample then decode continues.
    spu.ram[0] = 0x0c; spu.ram[1] = 0x04; spu.ram[2] = 0x77; // start marker
    // Block at 16: loop-end+mute (flags 0x01), nibble 0
    spu.ram[16] = 0x0c; spu.ram[17] = 0x01; spu.ram[18] = 0x00;
    const voice = spu.voices[0]!;
    spu.regs[V_SSA] = 0; // start at block 0
    spu.regs[V_LSAX] = 0;
    spu.regs[V_PITCH] = 0x4000; // 4 samples per clock
    spu.regs[V_ADSR1] = 0x000f; // fast linear attack
    spu.regs[V_ADSR2] = 0xf000;
    spu.keyOn(1);
    for (let i = 0; i < 40; i++) spu.tick(768);
    // LSAX register was overwritten with the loop-start block address (0).
    expect(spu.regs[V_LSAX]).toBe(0);
    expect(voice.endx).toBe(true);
    // End+mute forced envelope to release at level 0.
    expect(voice.env.phase).toBe("release");
    expect(voice.env.level).toBe(0);
    // ENDX latch visible in the status register.
    expect(spu.read(0x019c) & 1).not.toBe(0);
    // Key-on clears ENDX again.
    spu.keyOn(1);
    expect(spu.read(0x019c) & 1).toBe(0);
  });

  test("end+repeat flag loops back to repeat address without muting", () => {
    const spu = new Spu();
    // Block 0: loud zigzag, loop-start+end+repeat (0x07) so it loops onto itself.
    spu.ram[0] = 0x0f; // shift 15 invalid->9, filter 0
    spu.ram[1] = 0x07; // end + repeat + start
    spu.ram[2] = 0x77; // nibbles all 7 -> samples 7<<9
    const voice = spu.voices[0]!;
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x7fef; // attack: linear, shift 31, step 7
    spu.regs[V_ADSR2] = 0x0000;
    spu.keyOn(1);
    for (let i = 0; i < 200; i++) spu.tick(768);
    expect(voice.endx).toBe(true);
    expect(voice.env.phase).not.toBe("release"); // still looping audibly
  });
});

describe("SPU gaussian pitch interpolation", () => {
  test("gauss table is 512 entries and center index is passthrough", () => {
    expect(GAUSS.length).toBe(512);
    // i=0x80 at center: weights (gauss[0x7f], gauss[0x17f], gauss[0x180], gauss[0x80])
    // must pass the 'new' sample through: gauss[0x80]=0x3509 dominates.
    const out = gaussInterpolate(0x80, 0, 0, 0, 1000);
    expect(out).toBe((GAUSS[0x80]! * 1000) >> 15);
  });

  test("pitch 1.0 (0x1000) steps one sample per clock from index center", () => {
    const ram = new Uint8Array(SPU_RAM_SIZE);
    ram[0] = 0x0c; ram[1] = 0; ram[2] = 0x21; ram[3] = 0x43; // ramp nibbles
    const regs = new Uint16Array(8);
    regs[V_PITCH] = 0x1000;
    const voice = new SpuVoice(0, regs);
    voice.keyOn(ram);
    expect(voice.pitchCounter).toBe(0);
    voice.clock(ram);
    expect(voice.pitchCounter).toBe(0); // 0x1000 wraps exactly one sample
    expect(voice.bufIdx).toBe(1);
    // bits 4-11 are 0 -> interpolation index 0, output near decodeBuf[1].
    const s = voice.sample();
    const decoded = voice.decodeBuf[1]!;
    expect(Math.abs(s - decoded)).toBeLessThanOrEqual(4);
  });

  test("half pitch (0x0800) advances one sample every two clocks", () => {
    const ram = new Uint8Array(SPU_RAM_SIZE);
    ram[0] = 0x0c; ram[1] = 0; ram[2] = 0x11; // nibbles 1,1
    const regs = new Uint16Array(8);
    regs[V_PITCH] = 0x0800;
    const voice = new SpuVoice(0, regs);
    voice.keyOn(ram);
    voice.clock(ram);
    expect(voice.bufIdx).toBe(0);
    expect(voice.pitchCounter).toBe(0x800);
    voice.clock(ram);
    expect(voice.bufIdx).toBe(1);
    expect(voice.pitchCounter).toBe(0);
  });

  test("pitch clips to 0x4000 (176.4kHz max)", () => {
    const ram = new Uint8Array(SPU_RAM_SIZE);
    const regs = new Uint16Array(8);
    regs[V_PITCH] = 0xffff; // over max
    const voice = new SpuVoice(0, regs);
    voice.keyOn(ram);
    voice.clock(ram);
    // clamped step 0x4000: 4 samples stepped
    expect(voice.bufIdx).toBe(4);
    expect(voice.pitchCounter).toBe(0);
  });
});

describe("SPU ADSR envelope", () => {
  /** Fast envelope: linear attack shift 0 step 7, decay shift 0 (exp -8),
   *  sustain linear increase shift 0 step 7, release linear shift 0 (-8). */
  function makeEnvelope(adsr1 = 0x000f, adsr2 = 0xf000): Adsr {
    const regs = new Uint16Array(8);
    regs[4] = adsr1;
    regs[5] = adsr2;
    return new Adsr(regs, 0);
  }

  test("attack rises to 0x7fff then transitions to decay", () => {
    // linear attack: shift 0, step 7 -> +7<<11 = +14336 per update
    const env = makeEnvelope();
    env.keyOn();
    expect(env.phase).toBe("attack");
    expect(env.level).toBe(0);
    const levels: number[] = [];
    for (let i = 0; i < 10 && env.phase === "attack"; i++) {
      env.step();
      levels.push(env.level);
    }
    expect(env.phase).toBe("decay");
    expect(env.level).toBe(0x7fff);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    }
  });

  test("decay drops exponentially to sustain level then sustains", () => {
    // attack fast (shift 0 step 3), sustain level 5 -> (5+1)*0x800 = 0x3000
    const env = makeEnvelope(0x0305, 0x4000 | (31 << 8) | (0 << 6)); // sustain decrease, slowest
    env.keyOn();
    while (env.phase === "attack") env.step();
    expect(env.phase).toBe("decay");
    let prev = env.level;
    let guard = 0;
    while (env.phase === "decay" && guard++ < 200) {
      env.step();
      expect(env.level).toBeLessThanOrEqual(prev);
      expect(env.level).toBeGreaterThanOrEqual(0x1000);
      prev = env.level;
    }
    expect(env.phase).toBe("sustain");
    expect(env.level).toBeLessThanOrEqual(0x3000);
    // Sustain (slow decrease) keeps the level in range without collapsing.
    for (let i = 0; i < 50; i++) {
      env.step();
      expect(env.level).toBeGreaterThanOrEqual(0);
      expect(env.level).toBeLessThanOrEqual(0x3000);
    }
  });

  test("key off switches to release which decreases to zero", () => {
    const env = makeEnvelope(0x000f, 0xf000);
    env.keyOn();
    while (env.phase !== "sustain") env.step();
    const held = env.level;
    env.keyOff();
    expect(env.phase).toBe("release");
    let prev = env.level;
    let guard = 0;
    while (env.level > 0 && guard++ < 500) {
      env.step();
      expect(env.level).toBeLessThan(prev);
      prev = env.level;
    }
    expect(env.level).toBe(0);
    expect(held).toBeGreaterThan(0);
  });

  test("key off during attack aborts straight to release", () => {
    const env = makeEnvelope(0x010f); // linear attack shift 1, step 7: +7168/step
    env.keyOn();
    env.step();
    expect(env.level).toBeGreaterThan(0);
    env.keyOff();
    expect(env.phase).toBe("release");
  });

  test("exponential decay slows near zero (smaller steps at low level)", () => {
    const env = makeEnvelope();
    env.keyOn();
    while (env.phase !== "decay") env.step();
    // decay shift 11 -> step -8 per update scaled by level/0x8000
    env.level = 0x6000;
    env.step();
    const hi = env.level;
    env.level = 0x1000;
    env.step();
    const lo = env.level;
    expect(0x6000 - hi).toBeGreaterThan(0x1000 - lo);
  });

  test("ENVX register mirrors live envelope level", () => {
    const spu = new Spu();
    spu.regs[V_ADSR1] = 0x000f; // fast linear attack
    spu.regs[V_ADSR2] = 0xf000;
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x000f;
    spu.regs[V_ADSR2] = 0xf000;
    spu.keyOn(1);
    spu.tick(768 * 3);
    expect(spu.readVoice(0, 6)).toBe(spu.voices[0]!.env.level);
    expect(spu.voices[0]!.env.level).toBeGreaterThan(0);
  });
});

describe("SPU key on/off and register semantics", () => {
  test("keyOn register writes start the voice, KOF releases it", () => {
    const spu = new Spu();
    spu.writeVoice(3, V_SSA, 0);
    spu.writeVoice(3, V_PITCH, 0x1000);
    spu.regs[3 * 8 + V_ADSR1] = 0x000f;
    spu.regs[3 * 8 + V_ADSR2] = 0xf000;
    spu.write(0x0188, 1 << 3); // KON voice 3
    expect(spu.voices[3]!.env.phase).toBe("attack");
    spu.write(0x018c, 1 << 3); // KOF voice 3
    expect(spu.voices[3]!.env.phase).toBe("release");
    spu.write(0x018a, 1 << 7); // KON1: voice 16+7 = 23
    expect(spu.voices[23]!.env.phase).toBe("attack");
    spu.write(0x018e, 1 << 7);
    expect(spu.voices[23]!.env.phase).toBe("release");
  });

  test("keyOn/channelMask API sets envelope phase for all masked voices", () => {
    const spu = new Spu();
    spu.keyOn((1 << 0) | (1 << 5) | (1 << 20));
    expect(spu.voices[0]!.env.phase).toBe("attack");
    expect(spu.voices[5]!.env.phase).toBe("attack");
    expect(spu.voices[20]!.env.phase).toBe("attack");
    expect(spu.voices[1]!.env.phase).toBe("release");
    spu.keyOff((1 << 0) | (1 << 20));
    expect(spu.voices[0]!.env.phase).toBe("release");
    expect(spu.voices[5]!.env.phase).toBe("attack");
    expect(spu.voices[20]!.env.phase).toBe("release");
  });

  test("key on copies SSA to current address and resets pitch state", () => {
    const spu = new Spu();
    spu.writeVoice(2, V_SSA, 0x10); // byte address 0x80
    spu.writeVoice(2, V_PITCH, 0x1000);
    const voice = spu.voices[2]!;
    voice.pitchCounter = 0x999;
    voice.bufIdx = 9;
    spu.keyOn(1 << 2);
    expect(voice.pitchCounter).toBe(0);
    expect(voice.bufIdx).toBe(0);
    // keyOn decodes the first block; nibbles are zero so no loop flags -> next block
    expect(voice.addr).toBe(0x80 + 16);
  });

  test("data port writes land in SPU RAM and advance transfer address", () => {
    const spu = new Spu();
    spu.write(0x01a6, 0x10); // TSA: byte address 0x80
    spu.writeDataPort([0x1234, 0xbeef]);
    expect(spu.ram[0x80]).toBe(0x34);
    expect(spu.ram[0x81]).toBe(0x12);
    expect(spu.ram[0x82]).toBe(0xef);
    expect(spu.ram[0x83]).toBe(0xbe);
    expect(spu.read(0x01a6)).toBe(0x10); // register does not increment
  });

  test("ENVX register writes are ignored (read-only)", () => {
    const spu = new Spu();
    spu.writeVoice(1, 6, 0x1234);
    expect(spu.readVoice(1, 6)).toBe(0);
  });
});

describe("SPU mixing", () => {
  test("one keyed voice produces non-zero output in both channels", () => {
    const spu = new Spu();
    // Encode a known loud sample stream (all nibbles 7, shift 3 -> 7<<9 = 3584).
    const pcm = new Array(64).fill(3584);
    const adpcm = encodeSimpleFilter0(pcm, 3);
    spu.ram.set(adpcm, 0);
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x000f; // fast attack to max
    spu.regs[V_ADSR2] = 0xf000; // sustain linear increase
    spu.regs[V_VOLL] = 0x3fff; // voice volume ~max
    spu.regs[1 + V_VOLL] = 0x3fff; // VOLR
    spu.regs[0x0180] = 0x3fff; // main volume ~max
    spu.regs[0x0182] = 0x3fff;
    spu.write(0x01aa, 0xc000); // ATTR: SPU enable + unmute
    spu.keyOn(1);
    const outL = new Float32Array(1000);
    const outR = new Float32Array(1000);
    spu.mix(outL, outR);
    let peakL = 0;
    let peakR = 0;
    for (let i = 100; i < 1000; i++) { // skip attack ramp
      peakL = Math.max(peakL, Math.abs(outL[i]!));
      peakR = Math.max(peakR, Math.abs(outR[i]!));
    }
    expect(peakL).toBeGreaterThan(0.05);
    expect(peakR).toBeGreaterThan(0.05);
    expect(Math.max(...outL)).toBeLessThanOrEqual(1);
    expect(Math.min(...outL)).toBeGreaterThanOrEqual(-1);
  });

  test("muted ATTR silences output even with keyed voice", () => {
    const spu = new Spu();
    const pcm = new Array(64).fill(3584);
    spu.ram.set(encodeSimpleFilter0(pcm, 3), 0);
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x000f;
    spu.regs[V_ADSR2] = 0xf000;
    spu.regs[V_VOLL] = 0x3fff;
    spu.regs[1 + V_VOLL] = 0x3fff; // VOLR
    spu.regs[0x0180] = 0x3fff;
    spu.regs[0x0182] = 0x3fff;
    spu.write(0x01aa, 0x8000); // enabled but muted (bit14=0)
    spu.keyOn(1);
    const outL = new Float32Array(200);
    const outR = new Float32Array(200);
    spu.mix(outL, outR);
    for (let i = 0; i < 200; i++) {
      expect(outL[i]).toBe(0);
      expect(outR[i]).toBe(0);
    }
  });

  test("tick advances one output sample per 768 CPU cycles", () => {
    const spu = new Spu();
    const voice = spu.voices[0]!;
    spu.regs[V_PITCH] = 0x1000;
    spu.keyOn(1);
    spu.tick(768);
    expect(voice.bufIdx).toBe(1);
    spu.tick(768);
    expect(voice.bufIdx).toBe(2);
    spu.tick(100); // sub-sample: no advance
    expect(voice.bufIdx).toBe(2);
  });

  test("keyed-off voice contributes silence; released voice decays to zero", () => {
    const spu = new Spu();
    const pcm = new Array(64).fill(3584);
    spu.ram.set(encodeSimpleFilter0(pcm, 3), 0);
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x000f;
    spu.regs[V_ADSR2] = 0x0000; // release shift 0 -> -16384/apply: near-instant release
    spu.regs[V_VOLL] = 0x3fff;
    spu.regs[1 + V_VOLL] = 0x3fff; // VOLR
    spu.regs[0x0180] = 0x3fff;
    spu.regs[0x0182] = 0x3fff;
    spu.write(0x01aa, 0xc000);
    spu.keyOn(1);
    const outL = new Float32Array(6000);
    const outR = new Float32Array(6000);
    // Mix 100 samples (attack to max), then key off: release -16384/apply
    // (shift 0) reaches 0 within ~3 envelope steps.
    spu.mix(outL.subarray(0, 100), outR.subarray(0, 100));
    spu.keyOff(1);
    spu.mix(outL.subarray(100), outR.subarray(100));
    let tailPeak = 0;
    for (let i = 5500; i < 6000; i++) tailPeak = Math.max(tailPeak, Math.abs(outL[i]!));
    expect(tailPeak).toBe(0); // release reached level 0
  });
});

describe("SPU direct volume scaling", () => {
  test("direct volume register is signed 15-bit doubled", () => {
    expect(directVolume(0x3fff)).toBe(0x7ffe);
    expect(directVolume(0x4000)).toBe(-0x8000);
    expect(directVolume(0x0000)).toBe(0);
  });

  test("reset returns registers, RAM and status to defaults", () => {
    const spu = new Spu();
    spu.regs[0x80] = 0xffff;
    spu.ram[0] = 0xff;
    spu.reset();
    expect(spu.regs[0x80]).toBe(0);
    expect(spu.ram[0]).toBe(0);
    expect(spu.read(0x01ae) & 0x8000).toBe(0);
    expect(SPU_RAM_SIZE).toBe(0x80000);
  });
});

describe("SPU sweep volume envelopes", () => {
  test("linear sweep decrease from 0x4000 reaches 0 with exact step sequence", () => {
    // reg 0x8000|0x2000|0x2c = decrease, linear, shift 11, step 4:
    // step = ~7 = -8 << 0 = -8 per update, counter 8000h (every sample).
    const st = { counter: 0 };
    const p = sweepParams(0x8000 | 0x2000 | (11 << 2) | 0);
    expect(p).toEqual({ rate: 11 << 2, decreasing: true, exponential: false, phaseNegative: false });
    let level = 0x4000;
    const seq: number[] = [];
    let active = true;
    while (active && seq.length < 2048) {
      const r = sweepStep(level, p, st);
      level = r.level;
      active = r.active;
      seq.push(level);
    }
    expect(seq[0]).toBe(0x4000 - 8);
    expect(seq[1]).toBe(0x4000 - 16);
    expect(seq[seq.length - 1]).toBe(0);
    expect(active).toBe(false);
    expect(seq.length).toBe(0x4000 / 8); // exact number of updates
  });

  test("exponential decrease scales the step by level (slower near zero)", () => {
    const st = { counter: 0 };
    const p = sweepParams(0x8000 | 0x4000 | 0x2000 | (11 << 2) | 0);
    let level = 0x4000;
    const r1 = sweepStep(level, p, st);
    expect(r1.level).toBe(level + ((-8 * level) >> 15)); // ≈ -1 at 0x4000
    // Compare with linear at the same level: -8.
    const lin = sweepParams(0x8000 | 0x2000 | (11 << 2) | 0);
    expect(sweepStep(0x4000, lin, { counter: 0 }).level).toBe(0x4000 - 8);
  });

  test("linear increase saturates at 0x7fff and deactivates", () => {
    const st = { counter: 0 };
    const p = sweepParams(0x8000 | (11 << 2) | 0); // increase, linear, -8.. wait: +7
    let level = 0x7ff8;
    const r = sweepStep(level, p, st);
    expect(r.level).toBe(0x7fff);
    expect(r.active).toBe(false);
  });

  test("rate all-ones (7Fh) never steps, never saturates", () => {
    const st = { counter: 0 };
    const p = sweepParams(0x8000 | 0x7f);
    const r = sweepStep(0x1234, p, st);
    expect(r.level).toBe(0x1234);
    expect(r.active).toBe(true);
    expect(st.counter).toBe(0);
  });

  test("slow rate (shift > 11) waits 2^(shift-11) samples between steps", () => {
    // shift 15: increment 8000h >> 4 = 800h → step every 16 samples.
    const st = { counter: 0 };
    const p = sweepParams(0x8000 | 0x2000 | (15 << 2) | 0);
    let stepped = 0;
    let level = 0x4000;
    for (let i = 0; i < 16; i++) {
      const r = sweepStep(level, p, st);
      if (r.level !== level) stepped++;
      level = r.level;
    }
    expect(stepped).toBe(1);
    expect(level).toBe(0x4000 - 8);
  });

  test("voice in sweep mode: VOLL sweep fades mixed output from loud to silence", () => {
    const spu = new Spu();
    // Loud zigzag loop (same encoding as the mixing tests: nibbles 7, shift 3).
    spu.ram[0] = 0x03; // shift 3, filter 0
    spu.ram[1] = 0x07; // end+repeat+start: loop onto itself
    for (let i = 2; i < 16; i++) spu.ram[i] = 0x77;
    const voice = spu.voices[0]!;
    spu.regs[V_SSA] = 0;
    spu.regs[V_PITCH] = 0x1000;
    spu.regs[V_ADSR1] = 0x000f; // fast attack to max
    spu.regs[V_ADSR2] = 0xf000; // sustain holds
    // VOLL: sweep-mode decrease, shift 11 step 0 → -8 per sample: reaches 0
    // after 2048 samples. VOLR stays direct max.
    spu.regs[V_VOLL] = 0x8000 | 0x2000 | (11 << 2) | 0;
    spu.regs[1 + V_VOLL] = 0x3fff; // VOLR direct max
    spu.regs[0x0180] = 0x3fff;
    spu.regs[0x0182] = 0x3fff;
    spu.write(0x01aa, 0xc000); // ATTR: SPU enable + unmute
    spu.keyOn(1);
    const earlyL = new Float32Array(50);
    const earlyR = new Float32Array(50);
    spu.mix(earlyL, earlyR);
    expect(Math.max(...Array.from(earlyL).map(Math.abs))).toBeGreaterThan(0.01);
    // 2600 samples > 2048: the left sweep has landed on zero.
    const lateL = new Float32Array(100);
    const lateR = new Float32Array(100);
    for (let i = 0; i < 26; i++) spu.tick(768 * 100);
    spu.mix(lateL, lateR);
    expect(Math.max(...Array.from(lateL).map(Math.abs))).toBe(0);
    expect(Math.max(...Array.from(lateR).map(Math.abs))).toBeGreaterThan(0.01);
    expect(voice.sweepLevelL).toBe(0);
  });
});
