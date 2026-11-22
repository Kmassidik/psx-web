import { describe, test, expect } from "bun:test";
import { parseCue, parseIso } from "../src/core/loader/disc";

const SECTOR = 2352;
const SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

/** A MODE2/2352 sector: sync pattern + subheader AA AA 09 00 at bytes 12..15. */
function mode2Sector(fill: number): Uint8Array {
  const s = new Uint8Array(SECTOR);
  s.set(SYNC, 12);
  s.set([0xaa, 0xaa, 0x09, 0x00], 24); // subheader at offset 12+12 (raw form)
  s[28] = fill;
  return s;
}

/** A CUE/BIN MODE2 disc with `n` sectors, INDEX 01 at 00:02:00 (conventional). */
function makeCueBin(n: number, fill: (i: number) => number = (i) => i + 1): {
  cue: string;
  bin: Uint8Array;
} {
  const bin = new Uint8Array(n * SECTOR);
  for (let i = 0; i < n; i++) bin.set(mode2Sector(fill(i)), i * SECTOR);
  const cue = [
    'FILE "game.bin" BINARY',
    "  TRACK 01 MODE2/2352",
    "    INDEX 01 00:02:00",
  ].join("\n");
  return { cue, bin };
}

describe("CUE/BIN loader (MODE2/2352)", () => {
  test("3-sector disc: sectors, offsets, MSF round trip", () => {
    const { cue, bin } = makeCueBin(3);
    const disc = parseCue(cue, () => bin)!;
    expect(disc.sectorSize).toBe(2352);
    expect(disc.sectors.length).toBe(3);
    // INDEX 01 00:02:00 = LBA 150; bin sector 0 = disc LBA 150 = offset 0.
    expect(disc.msfToOffset(0, 2, 0)).toBe(0);
    // MSF 0:02:01 → LBA 151 → sector 1 → offset 2352.
    expect(disc.msfToOffset(0, 2, 1)).toBe(2352);
    // Payload intact: sector 0 fill byte is 1 (fill(0)+1).
    expect(disc.sectors[0][28]).toBe(1);
    expect(disc.sectors[2][28]).toBe(3);
    // Round trip: offset back → sector index → same raw bytes.
    const off = disc.msfToOffset(0, 2, 2);
    expect(disc.sectors[off / 2352]).toBe(disc.sectors[2]);
  });

  test("INDEX 01 00:04:00 anchors file sector 0 at disc LBA 300", () => {
    const n = 200;
    const bin = new Uint8Array(n * SECTOR);
    for (let i = 0; i < n; i++) bin.set(mode2Sector(i & 0xff), i * SECTOR);
    const cue = 'FILE "a.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:04:00';
    const disc = parseCue(cue, () => bin)!;
    expect(disc.sectors.length).toBe(200); // all file sectors kept
    // Disc LBA 300 (0:04:00) → file sector 0 → offset 0.
    expect(disc.msfToOffset(0, 4, 0)).toBe(0);
    // LBA 300+199 stays in range; LBA 500 clamps to the last sector.
    expect(disc.msfToOffset(0, 6, 49)).toBe(199 * 2352);
    expect(disc.msfToOffset(0, 99, 0)).toBe(199 * 2352);
    // Pregap LBAs (< 300) clamp to offset 0.
    expect(disc.msfToOffset(0, 2, 0)).toBe(0);
  });

  test("INDEX 01 00:00:00 cue keeps every bin sector", () => {
    const { cue, bin } = makeCueBin(4, () => 0xaa);
    const cue00 = cue.replace("00:02:00", "00:00:00");
    const disc = parseCue(cue00, () => bin)!;
    expect(disc.sectors.length).toBe(4);
    expect(disc.msfToOffset(0, 0, 0)).toBe(0);
    expect(disc.msfToOffset(0, 0, 3)).toBe(3 * 2352);
  });

  test("past-the-end MSF clamps to last sector", () => {
    const { cue, bin } = makeCueBin(3);
    const disc = parseCue(cue, () => bin)!;
    expect(disc.msfToOffset(0, 99, 0)).toBe(2 * 2352);
    expect(disc.msfToOffset(70, 0, 0)).toBe(2 * 2352);
  });
});

describe("CUE/BIN loader (MODE1/2048)", () => {
  test("plain 2048 sectors: byte offset == LBA math, data unstripped", () => {
    const data = new Uint8Array(2 * 2048);
    data[0] = 0x11;
    data[2048] = 0x22;
    const cue = 'FILE "m1.bin" BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:02:00';
    const disc = parseCue(cue, () => data)!;
    expect(disc.sectorSize).toBe(2048);
    expect(disc.sectors.length).toBe(2);
    // INDEX 01 00:02:00 anchors file sector 0 at disc LBA 150.
    expect(disc.msfToOffset(0, 2, 0)).toBe(0);
    expect(disc.msfToOffset(0, 2, 1)).toBe(2048);
    expect(disc.sectors[0][0]).toBe(0x11);
    expect(disc.sectors[1][0]).toBe(0x22);
  });
});

describe("CUE/BIN loader (multiple BIN files)", () => {
  test("two tracks, two files: each starts at its own disc LBA", () => {
    const bin1 = new Uint8Array(2 * SECTOR);
    bin1.set(mode2Sector(0x01), 0);
    bin1.set(mode2Sector(0x02), SECTOR);
    const bin2 = new Uint8Array(3 * SECTOR);
    for (let i = 0; i < 3; i++) bin2.set(mode2Sector(0x10 + i), i * SECTOR);
    const cue = [
      'FILE "track1.bin" BINARY',
      "  TRACK 01 MODE2/2352",
      "    INDEX 01 00:02:00",
      'FILE "track2.bin" BINARY',
      "  TRACK 02 MODE2/2352",
      "    INDEX 01 00:06:00",
    ].join("\n");
    const files: Record<string, Uint8Array> = { "track1.bin": bin1, "track2.bin": bin2 };
    const disc = parseCue(cue, (name) => files[name])!;
    expect(disc.sectors.length).toBe(5); // 2 + 3
    // Track 1: disc LBA 150..151 (0:02:00-0:02:01).
    expect(disc.msfToOffset(0, 2, 0)).toBe(0);
    expect(disc.sectors[disc.msfToOffset(0, 2, 1) / 2352][28]).toBe(0x02);
    // Track 2: INDEX 01 00:06:00 = LBA 450; its bin sector 0 is disc LBA 450.
    expect(disc.msfToOffset(0, 6, 0)).toBe(2 * 2352);
    expect(disc.sectors[disc.msfToOffset(0, 6, 0) / 2352][28]).toBe(0x10);
    expect(disc.msfToOffset(0, 6, 2)).toBe(4 * 2352);
    // Past track 2's end clamps inside track 2.
    expect(disc.msfToOffset(0, 99, 0)).toBe(4 * 2352);
  });
});

describe("malformed CUE → undefined", () => {
  const bin = new Uint8Array(3 * SECTOR);
  for (let i = 0; i < 3; i++) bin.set(mode2Sector(0), i * SECTOR);
  const getBin = () => bin;

  test("missing FILE", () => {
    expect(parseCue("TRACK 01 MODE2/2352\nINDEX 01 00:02:00", getBin)).toBeUndefined();
  });

  test("unknown track type (AUDIO)", () => {
    expect(
      parseCue('FILE "a.bin" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:02:00', getBin),
    ).toBeUndefined();
  });

  test("missing bin file", () => {
    expect(parseCue('FILE "nope.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:02:00', () => undefined)).toBeUndefined();
  });

  test("no INDEX 01", () => {
    expect(parseCue('FILE "a.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 00 00:00:00', getBin)).toBeUndefined();
  });

  test("INDEX 01 without TRACK", () => {
    expect(parseCue('FILE "a.bin" BINARY\nINDEX 01 00:02:00', getBin)).toBeUndefined();
  });

  test("malformed MSF (seconds > 59, frames > 74)", () => {
    expect(
      parseCue('FILE "a.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:60:00', getBin),
    ).toBeUndefined();
    expect(
      parseCue('FILE "a.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:75', getBin),
    ).toBeUndefined();
  });

  test("non-BINARY FILE type", () => {
    expect(
      parseCue('FILE "a.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:02:00', getBin),
    ).toBeUndefined();
  });

  test("unrecognized directive", () => {
    expect(
      parseCue('FILE "a.bin" BINARY\nCDTEXTFILE "a.cdt"\nTRACK 01 MODE2/2352\nINDEX 01 00:02:00', getBin),
    ).toBeUndefined();
  });

  test("empty cue", () => {
    expect(parseCue("", getBin)).toBeUndefined();
  });
});

describe("parseIso raw image detection", () => {
  test("2352 raw bin detected by sync pattern", () => {
    const n = 4;
    const buf = new Uint8Array(n * SECTOR);
    for (let i = 0; i < n; i++) buf.set(mode2Sector(i + 5), i * SECTOR);
    const disc = parseIso(buf);
    expect(disc.sectorSize).toBe(2352);
    expect(disc.sectors.length).toBe(4);
    // Raw track: file sector 0 = disc LBA 150 (00:02:00).
    expect(disc.msfToOffset(0, 2, 0)).toBe(0);
    expect(disc.msfToOffset(0, 2, 3)).toBe(3 * 2352);
    // Disc LBA 0 (00:00:00) is in the pregap → clamps to offset 0.
    expect(disc.msfToOffset(0, 0, 0)).toBe(0);
    expect(disc.sectors[0][28]).toBe(5);
    expect(disc.sectors[3][28]).toBe(8);
  });

  test("2048 iso (no sync pattern) detected as session image", () => {
    const n = 3;
    const buf = new Uint8Array(n * 2048);
    buf[0] = 0xcd; // "CD001" lives at ISO9660 sector 16, byte 1
    new TextEncoder().encodeInto("CD001", buf.subarray(16 * 2048 + 1));
    const disc = parseIso(buf);
    expect(disc.sectorSize).toBe(2048);
    expect(disc.sectors.length).toBe(3);
    // File sector 0 = disc LBA 16 (system area offset).
    expect(disc.msfToOffset(0, 0, 16)).toBe(0);
    expect(disc.msfToOffset(0, 0, 17)).toBe(2048);
    // Disc LBA 0-15 precede the file → clamp to offset 0.
    expect(disc.msfToOffset(0, 0, 0)).toBe(0);
    expect(buf.subarray(0, 2048)[0]).toBe(0xcd);
  });

  test("MSF↔offset round trip on a 2352 image", () => {
    const buf = new Uint8Array(75 * SECTOR); // 1 second of sectors
    for (let i = 0; i < 75; i++) buf.set(mode2Sector(i), i * SECTOR);
    const disc = parseIso(buf);
    expect(disc.sectorSize).toBe(2352);
    for (let f = 0; f < 75; f++) {
      const off = disc.msfToOffset(0, 2, f); // 0:02:f = LBA 150+f
      const sectorIdx = Math.round(off / SECTOR);
      expect(sectorIdx).toBe(f); // LBA 150+f − 150 pregap = f
      expect(disc.sectors[sectorIdx][28]).toBe(f & 0xff);
    }
  });
});
