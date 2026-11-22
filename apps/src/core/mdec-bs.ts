/**
 * MDEC BS bitstream front end ("decode16") — Sony's variable-length huffman
 * layer, separate from the hardware run-level path in mdec.ts. Decodes BS
 * v1/v2 (raw 10-bit DC) and v3 (delta-coded DC, MPEG-1 size codes) into the
 * run-level halfword stream the hardware consumes, and encodes run-level back
 * to BS v2 (DecDCTvlc / its inverse).
 *
 * Format notes (psx-spx "DC v1/v2/ea" + pcsx-redux retail-stream measurements):
 * - Word 0 of the 8-byte header IS the MDEC(1) decode command → magic 0x3800.
 * - v1/v2 carry a raw 10-bit DC per block; 0x1FF in that slot is End of Frame.
 * - ONLY v3 delta-codes the DC (Cr/Cb predictors, shared Y predictor).
 * - Escape code: 6-bit ESC then the 16-bit run-level word VERBATIM.
 * - Frames end at 0x1FF then pad to 32-bit words; the header length counts
 *   run-level halfwords, and the decoder fills FE00 footers up to it.
 */
import {
  BS_END_OF_FRAME,
  BitReader,
  BitWriter,
  DC_SIZE_CHROMA,
  DC_SIZE_LUMA,
  VLC_DECODE_TABLE,
  VLC_EOB,
  VLC_ESC,
  VLC_MAX_LEVEL,
  VLC_RUN,
  type DcSizeCode,
  type VlcCode,
} from "./mdec-tables";

const EOB = 0xfe00;

/** Decode a BS bitstream to run-level halfwords (DecDCTvlc equivalent). */
export function decode16(bs: Uint8Array): Uint16Array {
  if (bs.length < 8) return new Uint16Array(0);
  const dv = new DataView(bs.buffer, bs.byteOffset, bs.byteLength);
  const rlWords = dv.getUint16(0, true);
  const magic = dv.getUint16(2, true);
  const quant = dv.getUint16(4, true);
  const version = dv.getUint16(6, true);
  if (magic !== 0x3800) return new Uint16Array(0);
  if (version === 0 || version > 3) return new Uint16Array(0);
  const deltaDc = version === 3;
  const target = rlWords * 2;
  const rl: number[] = [];
  const br = new BitReader(bs.subarray(8));
  const lastDc = [0, 0, 0];
  let blockInMb = 0;
  while (rl.length < target && !br.overrun) {
    const blockStart = rl.length;
    let dc: number;
    if (!deltaDc) {
      dc = br.get(10);
      if (dc === BS_END_OF_FRAME) break; // End of Frame code
    } else {
      const luma = blockInMb >= 2;
      const book: readonly DcSizeCode[] = luma ? DC_SIZE_LUMA : DC_SIZE_CHROMA;
      let size = -1;
      for (let s = 0; s < 9; s++) {
        if (br.peek(book[s]!.length) === book[s]!.code) {
          size = s;
          break;
        }
      }
      if (size < 0 || br.overrun) break;
      const sz = book[size]!;
      br.get(sz.length);
      let delta = 0;
      if (size > 0) {
        const raw = br.get(size);
        // Top bit set = positive; else offset from -(2^size - 1).
        delta = (raw & (1 << (size - 1))) !== 0 ? raw : raw - ((1 << size) - 1);
      }
      const pred = luma ? 2 : blockInMb; // Y shares one predictor
      lastDc[pred] = (lastDc[pred] ?? 0) + delta * 4;
      dc = lastDc[pred]! & 0x3ff;
      if (++blockInMb === 6) blockInMb = 0;
    }
    if (br.overrun) break;
    rl.push(((quant & 0x3f) << 10) | (dc & 0x3ff));
    let closed = false;
    while (!closed) {
      if (rl.length >= target) {
        rl.length = blockStart; // block does not fit: drop it
        br.overrun = true;
        break;
      }
      let code = 0;
      let found: { run: number; level: number; escape: boolean; eob: boolean } | undefined;
      for (let bits = 1; bits <= 17 && found === undefined; bits++) {
        code = (code << 1) | br.get(1);
        found = VLC_DECODE_TABLE.get((bits << 20) | code);
      }
      if (found === undefined || br.overrun) {
        rl.length = blockStart;
        br.overrun = true;
        break;
      }
      if (found.eob) {
        rl.push(EOB);
        closed = true;
      } else if (found.escape) {
        rl.push(br.get(16)); // raw run-level word, verbatim
      } else {
        rl.push(((found.run & 0x3f) << 10) | (found.level & 0x3ff));
      }
    }
    if (br.overrun) break;
  }
  while (rl.length < target) rl.push(EOB); // footers the bitstream omits
  return new Uint16Array(rl);
}

/** Encode run-level halfwords into a BS v2 bitstream (decode16 inverse). */
export function encode16(rl: Uint16Array): Uint8Array {
  interface EncBlock {
    header: number;
    ac: number[];
  }
  const blocks: EncBlock[] = [];
  let i = 0;
  let minQ = 64;
  let maxQ = -1;
  let halfwords = 0;
  while (i < rl.length) {
    while (i < rl.length && rl[i] === EOB) i++; // skip padding
    if (i >= rl.length) break;
    const header = rl[i++]!;
    const q = (header >>> 10) & 0x3f;
    minQ = Math.min(minQ, q);
    maxQ = Math.max(maxQ, q);
    const ac: number[] = [];
    while (i < rl.length && rl[i] !== EOB) ac.push(rl[i++]!);
    if (i >= rl.length) throw new Error("stream ends mid-block, no FE00 terminator");
    i++;
    blocks.push({ header, ac });
    halfwords += ac.length + 2;
  }
  if (blocks.length === 0) throw new Error("no blocks in stream");
  if (minQ !== maxQ) throw new Error("q_scale varies across the frame and BS carries QUANT once");
  const padded = (halfwords + 0x3f) & ~0x3f;
  const rlWords = (padded + 1) >> 1;
  if (rlWords > 0xffff) throw new Error("run-level stream too long for the BS header");
  const bw = new BitWriter();
  for (const block of blocks) {
    const dc = block.header & 0x3ff;
    // DC 0x1FF is the End of Frame code: saturate to +510 instead.
    bw.put(dc === BS_END_OF_FRAME ? BS_END_OF_FRAME - 1 : dc, 10);
    for (const w of block.ac) {
      const run = (w >>> 10) & 0x3f;
      let level = w & 0x3ff;
      if ((level & 0x200) !== 0) level -= 0x400;
      const mag = Math.abs(level);
      const c: VlcCode | undefined =
        run < 32 && mag >= 1 && mag <= VLC_MAX_LEVEL[run]! ? VLC_RUN[run]![mag - 1] : undefined;
      if (c !== undefined && c.bits !== 0) {
        bw.put(level < 0 ? c.code | 1 : c.code, c.bits);
      } else {
        // Off the book: ESC, then the 16-bit run-level word verbatim.
        bw.put(VLC_ESC.code, VLC_ESC.bits);
        bw.put(w & 0xffff, 16);
      }
    }
    bw.put(VLC_EOB.code, VLC_EOB.bits);
  }
  bw.put(BS_END_OF_FRAME, 10); // End of Frame in the next DC slot
  bw.finish(); // pad to byte, then to 32-bit words
  const out = new Uint8Array(8 + bw.bytes.length);
  const odv = new DataView(out.buffer);
  odv.setUint16(0, rlWords, true);
  odv.setUint16(2, 0x3800, true); // word 0 IS the MDEC(1) decode command
  odv.setUint16(4, minQ, true);
  odv.setUint16(6, 2, true); // BS v2: raw DC
  out.set(bw.bytes, 8);
  return out;
}
