import { describe, test, expect } from "bun:test";
import { parseChd } from "../src/core/loader/chd";
import { parsePbp } from "../src/core/loader/pbp";
import { deflateSync } from "bun"; // raw deflate — matches the CHD zlib codec exactly

// ---- fixture helpers (big-endian encoders, 3+ call sites each) ----
const u32be = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
};
const u64be = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), false);
  return b;
};
const bytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32le = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const ascii = (s: string) => new TextEncoder().encode(s);

const HUNK = 2048;
const V4_HEADER = 108;
const V5_HEADER = 124;
const MAP_ENTRY = 16;

/** Hand-built CHD v4 header (codec 1 = zlib/raw-deflate, or pass 0). */
function chd4Header(hunkCount: number, logicalBytes: number, codec = 1): Uint8Array {
  return bytes(
    ascii("MComprHD"),
    u32be(V4_HEADER), // header length
    u32be(4), // version
    u32be(0), // flags
    u32be(codec), // compression enum
    u32be(hunkCount), // totalhunks
    u64be(logicalBytes), // logicalbytes
    u64be(0), // metaoffset (none)
    u32be(HUNK), // hunkbytes
    new Uint8Array(V4_HEADER - 48), // sha1/parentsha1/rawsha1 padding
  );
}

/** Hand-built v3/v4-style 16-byte map entry (u64 off, u32 crc, 24-bit len, type). */
function map4Entry(offset: number, len: number, type: number, crc = 0): Uint8Array {
  const out = new Uint8Array(MAP_ENTRY);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, BigInt(offset), false);
  dv.setUint32(8, crc, false);
  dv.setUint16(12, len & 0xffff, false);
  dv.setUint8(14, (len >>> 16) & 0xff);
  dv.setUint8(15, type);
  return out;
}
const END_COOKIE = new Uint8Array(MAP_ENTRY); // zero-padded EndOfListCookie slot

describe("CHD v4 loader", () => {
  test("one stored + one raw-deflate hunk", async () => {
    const hunk0 = new Uint8Array(HUNK).map((_, i) => i & 0xff);
    const hunk1 = new Uint8Array(HUNK);
    const pattern = ascii("CD-ROM TRACK 1");
    hunk1.set(pattern, 100);
    const deflated = deflateSync(hunk1); // Bun/node zlib: raw deflate without wrapper here

    // map = 2 entries + EndOfListCookie = 48 bytes; hunks start after it
    const dataStart = V4_HEADER + 3 * MAP_ENTRY;
    const map = bytes(
      map4Entry(dataStart, HUNK, 2), // stored
      map4Entry(dataStart + HUNK, deflated.length, 1), // compressed
      END_COOKIE,
    );
    const chd = bytes(chd4Header(2, HUNK * 2, 1), map, hunk0, deflated);
    const parsed = await parseChd(chd);
    expect(parsed).toBeDefined();
    expect(parsed!.hunkSize).toBe(HUNK);
    expect(parsed!.hunks).toBe(2);

    const stored = await parsed!.readHunk(0);
    expect(stored.byteLength).toBe(HUNK);
    expect(stored[0]).toBe(0);
    expect(stored[HUNK - 1]).toBe((HUNK - 1) & 0xff);

    const inflated = await parsed!.readHunk(1);
    expect(inflated.byteLength).toBe(HUNK);
    expect(inflated.subarray(100, 100 + pattern.length)).toEqual(pattern);
  });

  test("mini hunk tiles the 8-byte offset-field pattern", async () => {
    const pattern = ascii("PSX-DISC");
    const map = bytes(map4Entry(0, 0, 3), END_COOKIE);
    // Put the pattern straight into the entry's offset field.
    const entry = map.subarray(0, MAP_ENTRY);
    entry.set(pattern, 0);
    const chd = bytes(chd4Header(1, HUNK, 0), map);
    const parsed = await parseChd(chd);
    expect(parsed).toBeDefined();
    const h = await parsed!.readHunk(0);
    expect(h.byteLength).toBe(HUNK);
    expect(h.subarray(0, 8)).toEqual(pattern);
    expect(h.subarray(HUNK - 8)).toEqual(pattern);
    expect(h[8]).toBe(pattern[0]);
  });

  test("self-reference resolves to the target hunk", async () => {
    const hunk0 = new Uint8Array(HUNK).map((_, i) => (i * 3) & 0xff);
    const dataStart = V4_HEADER + 3 * MAP_ENTRY;
    const map = bytes(
      map4Entry(dataStart, HUNK, 2), // hunk 0 stored
      map4Entry(0, 0, 4), // hunk 1 -> self ref to hunk 0
      END_COOKIE,
    );
    const chd = bytes(chd4Header(2, HUNK * 2, 0), map, hunk0);
    const parsed = await parseChd(chd);
    expect(parsed).toBeDefined();
    expect(await parsed!.readHunk(1)).toEqual(hunk0);
  });

  test("out-of-range hunk throws", async () => {
    const dataStart = V4_HEADER + 2 * MAP_ENTRY;
    const map = bytes(map4Entry(dataStart, HUNK, 2), END_COOKIE);
    const chd = bytes(chd4Header(1, HUNK, 0), map, new Uint8Array(HUNK));
    const parsed = await parseChd(chd);
    expect(parsed).toBeDefined();
    await expect(parsed!.readHunk(1)).rejects.toThrow(/out of range/);
    await expect(parsed!.readHunk(-1)).rejects.toThrow(/out of range/);
  });
});

describe("CHD v5 loader (uncompressed, flat u32 map)", () => {
  function v5Header(logicalBytes: number, entries: number[]): Uint8Array {
    return bytes(
      ascii("MComprHD"),
      u32be(V5_HEADER),
      u32be(5),
      new Uint8Array(16), // four compressor 4CC slots, all zero
      u64be(logicalBytes),
      u64be(V5_HEADER), // mapoffset
      u64be(0), // metaoffset
      u32be(HUNK), // hunkbytes
      u32be(HUNK), // unitbytes
      new Uint8Array(V5_HEADER - 64), // hash padding
      ...entries.map((e) => u32be(e)),
    );
  }

  test("exposes hunks via index*HUNK offsets", async () => {
    const h0 = new Uint8Array(HUNK).map((_, i) => (i * 7) & 0xff);
    const h1 = new Uint8Array(HUNK).map((_, i) => (i * 11) & 0xff);
    // Flat-map values are hunk indices; byte offset = value * HUNK from file
    // start. Header (124) + 2-entry map (8) occupy the first 132 bytes, so real
    // images leave hunk 0 as a hole; we pad so indices 1 and 2 land on h0/h1.
    const header = v5Header(2 * HUNK, [1, 2]);
    const chd = bytes(header, new Uint8Array(HUNK - header.length), h0, h1);
    const parsed = await parseChd(chd);
    expect(parsed).toBeDefined();
    expect(parsed!.hunkSize).toBe(HUNK);
    expect(parsed!.hunks).toBe(2);
    expect(await parsed!.readHunk(0)).toEqual(h0);
    expect(await parsed!.readHunk(1)).toEqual(h1);
  });

  test("map entry 0 is a hole, not an offset", async () => {
    const h = new Uint8Array(HUNK).fill(0xab);
    const header = v5Header(HUNK, [0]); // map entry 0 = hole
    const full = bytes(header, new Uint8Array(HUNK - header.length), h);
    const parsed = await parseChd(full);
    expect(parsed).toBeDefined();
    const hole = await parsed!.readHunk(0);
    expect(hole.byteLength).toBe(HUNK);
    expect(hole.every((b) => b === 0)).toBe(true);
  });

  test("compressed v5 (nonzero compressor slot) returns undefined", async () => {
    const chd = bytes(
      ascii("MComprHD"),
      u32be(V5_HEADER),
      u32be(5),
      ascii("zlib"), // compressor slot 0 set -> compressed map/hunks
      new Uint8Array(12),
      u64be(HUNK),
      u64be(V5_HEADER),
      u64be(0),
      u32be(HUNK),
      u32be(HUNK),
      new Uint8Array(V5_HEADER - 64),
    );
    expect(await parseChd(chd)).toBeUndefined();
  });
});

describe("CHD header rejection", () => {
  test("wrong magic returns undefined", async () => {
    const chd = bytes(chd4Header(1, HUNK));
    chd[0] = 0x58; // "X"
    expect(await parseChd(chd)).toBeUndefined();
  });

  test("unsupported version (v3) returns undefined", async () => {
    const h = chd4Header(1, HUNK);
    new DataView(h.buffer).setUint32(12, 3, false);
    expect(await parseChd(h)).toBeUndefined();
  });

  test("truncated header returns undefined", async () => {
    expect(await parseChd(new Uint8Array(0x40))).toBeUndefined();
  });

  test("zero hunk size returns undefined", async () => {
    const h = chd4Header(1, HUNK);
    new DataView(h.buffer).setUint32(44, 0, false);
    expect(await parseChd(h)).toBeUndefined();
  });

  test("v4 parent/secondary-codec map entry types rejected", async () => {
    for (const badType of [0, 5, 6]) {
      const map = bytes(map4Entry(V4_HEADER + MAP_ENTRY, HUNK, badType), END_COOKIE);
      const chd = bytes(chd4Header(1, HUNK, 0), map, new Uint8Array(HUNK));
      expect(await parseChd(chd)).toBeUndefined();
    }
  });
});

/** Hand-built PBP with the full 8-entry offset table (no$psx layout). */
function makePbp(psarOffset: number, iconOffset: number, iconSize = 8, psarSize = 8): Uint8Array {
  const iconData = new Uint8Array(iconSize);
  iconData[0] = 0x89; // PNG magic byte
  const psarData = new Uint8Array(psarSize);
  psarData[0] = 0x50; // "P" of "PSAR"
  const table = [
    0x28, // param.sfo
    iconOffset,
    iconOffset + iconSize, // icon1
    psarOffset + psarSize, // pic0
    psarOffset + psarSize, // pic1
    psarOffset + psarSize, // snd0
    psarOffset + psarSize, // DATA.PSP
    psarOffset, // DATA.PSAR
  ];
  return bytes(ascii("PBP"), new Uint8Array(5), ...table.map(u32le), iconData, psarData);
}

describe("PBP loader", () => {
  test("extracts PSAR and icon0 offsets from the 8-entry table", () => {
    const parsed = parsePbp(makePbp(0x40, 0x38));
    expect(parsed).toBeDefined();
    expect(parsed!.psarOffset).toBe(0x40);
    expect(parsed!.iconOffset).toBe(0x38);
  });

  test("rejects wrong magic", () => {
    const pbp = makePbp(0x40, 0x38);
    pbp[0] = 0x58;
    expect(parsePbp(pbp)).toBeUndefined();
  });

  test("rejects truncated header", () => {
    expect(parsePbp(new Uint8Array(0x10))).toBeUndefined();
  });

  test("rejects missing PSAR (offset 0 = not a PS1 eboot)", () => {
    expect(parsePbp(makePbp(0, 0x38))).toBeUndefined();
  });
});
