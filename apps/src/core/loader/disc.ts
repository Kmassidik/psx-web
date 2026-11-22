/**
 * Disc image loaders — mirrors load_fast_cdrom behavior (sector-based CD-ROM
 * access). Supports CUE/BIN (MODE2/2352, MODE1/2352, MODE1/2048 tracks,
 * multiple BIN files) and raw ISO/BIN images (2048 or 2352 bytes/sector,
 * detected by the 12-byte sync pattern at offset 12).
 *
 * MSF→offset conventions (documented decisions):
 * - CUE: INDEX 01 is the data start — the first sector of each FILE maps to
 *   the INDEX 01 LBA of that file's first track. The 2 s pregap convention
 *   (INDEX 01 00:02:00) only explains why the file starts at disc LBA 150;
 *   the pregap itself precedes the file's stored bytes and is not kept.
 *   A cue authoring INDEX 01 at 00:00:00 therefore maps file sector 0 to
 *   disc LBA 0. A second track inside the same FILE continues at its INDEX
 *   01 LBA within the same file range.
 * - Raw 2352 images (sync pattern) are disc tracks: file sector f is disc
 *   LBA f + 150 (pregap included).
 * - Raw 2048 images are ISO9660 sessions: file sector f is disc LBA f + 16
 *   (system area + volume descriptors precede the file's sector 0).
 *
 * msfToOffset returns a BYTE offset into the image (sectorIndex ×
 * sectorSize); sectors[offset / sectorSize] yields the raw sector. 2352
 * sectors keep sync/header/subheader — the CD-ROM task strips those per
 * mode. MSF before the image's first sector clamps to offset 0; past the
 * end clamps to the last sector.
 *
 * CUE parsing rejects (→ undefined) anything we cannot faithfully honor:
 * unknown FILE type, missing BIN, unsupported track type (AUDIO → CD-DA is
 * a later ticket), mixed sector sizes across tracks, missing/duplicate
 * INDEX 01 per TRACK, malformed MSF fields, and unrecognized directives
 * (FLAGS, PREGAP, CDTEXTFILE, …).
 *
 * No zlib/zip, no CHD/PBP here (separate ticket). Pure TS.
 */

export interface DiscImage {
  sectors: Uint8Array[]; // raw sectors, each exactly sectorSize bytes
  sectorSize: 2352 | 2048;
  /** Disc MSF → byte offset into the image (see convention note above). */
  msfToOffset(m: number, s: number, f: number): number;
}

const LBA_PER_SECOND = 75;
const LBA_PER_MINUTE = 60 * LBA_PER_SECOND;
const PREGAP_SECTORS = 150; // 2 seconds, the BIN/CUE convention
const ISO_SESSION_START = 16; // first ISO9660 sector on disc

/** 00 FF FF FF FF FF FF FF FF FF FF 00, at byte offset 12 of each raw sector. */
const SYNC: Record<number, number> = {
  0: 0x00,
  1: 0xff,
  2: 0xff,
  3: 0xff,
  4: 0xff,
  5: 0xff,
  6: 0xff,
  7: 0xff,
  8: 0xff,
  9: 0xff,
  10: 0xff,
  11: 0x00,
};

function hasSyncAt(d: Uint8Array, sectorStart: number): boolean {
  for (let i = 0; i < 12; i++) {
    if (d[sectorStart + 12 + i] !== SYNC[i]) return false;
  }
  return true;
}

function lbaOf(m: number, s: number, f: number): number {
  return m * LBA_PER_MINUTE + s * LBA_PER_SECOND + f;
}

function trackSectorSize(type: CueTrack["type"]): 2352 | 2048 {
  return type.endsWith("/2352") ? 2352 : 2048;
}

function isDataTrackType(type: string): boolean {
  return type === "MODE2/2352" || type === "MODE1/2352" || type === "MODE1/2048";
}

interface CueTrack {
  type: "MODE2/2352" | "MODE1/2352" | "MODE1/2048";
  bin: Uint8Array;
  index01Lba: number; // disc LBA of the track's data start (INDEX 01)
}

/**
 * Parse a CUE sheet into a DiscImage. `getBin` resolves FILE names.
 * Returns undefined for cues we cannot honor (see header doc). Only INDEX
 * 00 (pregap position, informational) and INDEX 01 (data start) are
 * accepted; higher indexes (multi-session style) reject.
 */
export function parseCue(
  cueText: string,
  getBin: (filename: string) => Uint8Array | undefined,
): DiscImage | undefined {
  const tracks: CueTrack[] = [];
  let currentBin: Uint8Array | undefined;
  let currentType: CueTrack["type"] | undefined;

  for (const rawLine of cueText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("REM") || line.startsWith("CATALOG")) continue;

    let match = /^FILE\s+"([^"]*)"\s+(\S+)$/i.exec(line);
    if (match) {
      const [, filename, fileType] = match;
      if (fileType === undefined || filename === undefined) return undefined;
      if (fileType.toUpperCase() !== "BINARY") return undefined;
      currentBin = getBin(filename);
      if (!currentBin) return undefined;
      continue;
    }

    match = /^TRACK\s+(\d+)\s+(\S+)$/i.exec(line);
    if (match) {
      const type = match[2]?.toUpperCase();
      if (type === undefined) return undefined;
      if (!isDataTrackType(type)) return undefined; // AUDIO etc.: unsupported
      if (currentType) return undefined; // previous TRACK had no INDEX 01
      currentType = type as CueTrack["type"];
      continue;
    }

    match = /^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)$/i.exec(line);
    if (match) {
      const indexNo = Number(match[1]);
      const mm = Number(match[2]);
      const ss = Number(match[3]);
      const ff = Number(match[4]);
      if (ss > 59 || ff > 74) return undefined; // malformed MSF
      if (indexNo > 1) return undefined; // only pregap (00) and data (01)
      if (indexNo === 1) {
        if (!currentBin || !currentType) return undefined; // INDEX before FILE/TRACK
        tracks.push({ type: currentType, bin: currentBin, index01Lba: lbaOf(mm, ss, ff) });
        currentType = undefined; // a TRACK gets exactly one INDEX 01
      }
      continue;
    }

    return undefined; // unrecognized directive: cannot faithfully honor
  }

  if (tracks.length === 0 || currentType) return undefined;

  const firstTrack = tracks[0];
  if (!firstTrack) return undefined;
  const sectorSize0 = trackSectorSize(firstTrack.type);
  for (const t of tracks) {
    if (trackSectorSize(t.type) !== sectorSize0) return undefined; // mixed sizes unsupported
  }
  const sectorSize = sectorSize0 as 2352 | 2048;

  // INDEX 01 is the data start: the first sector of each FILE maps to the
  // INDEX 01 LBA of that file's first track (the 2 s pregap convention is
  // why INDEX 01 sits at 00:02:00; the pregap itself precedes the file and
  // is not stored in it). All sectors of each file are kept; a second track
  // inside the same file simply lives at a higher LBA in the same range.
  interface FileRange {
    bin: Uint8Array;
    discStart: number; // disc LBA of this file's sector 0
    sectorBase: number; // index of this file's first sector in `sectors`
  }
  const sectors: Uint8Array[] = [];
  const fileRanges: FileRange[] = [];
  for (const track of tracks) {
    const last = fileRanges[fileRanges.length - 1];
    if (last && last.bin === track.bin) continue; // same file: sectors already taken
    const range: FileRange = {
      bin: track.bin,
      discStart: track.index01Lba,
      sectorBase: sectors.length,
    };
    fileRanges.push(range);
    const total = Math.floor(track.bin.byteLength / sectorSize);
    for (let i = 0; i < total; i++) {
      sectors.push(track.bin.subarray(i * sectorSize, (i + 1) * sectorSize));
    }
  }

  const msfToOffset = (m: number, s: number, f: number): number => {
    const lba = lbaOf(m, s, f);
    // Last file whose range starts at or before lba; clamp within it.
    let range = fileRanges[0];
    if (!range) return 0;
    for (let i = fileRanges.length - 1; i > 0; i--) {
      const candidate = fileRanges[i];
      if (candidate && lba >= candidate.discStart) {
        range = candidate;
        break;
      }
    }
    const sectorIndex = Math.min(
      Math.max(range.sectorBase + (lba - range.discStart), 0),
      sectors.length - 1,
    );
    return sectorIndex * sectorSize;
  };

  return { sectors, sectorSize, msfToOffset };
}

/** Parse a raw ISO (2048 B/sector) or raw BIN track (2352 B/sector) image. */
export function parseIso(data: Uint8Array): DiscImage {
  const is2352 = data.byteLength >= 2352 && hasSyncAt(data, 0);
  const sectorSize: 2352 | 2048 = is2352 ? 2352 : 2048;
  const discStart = is2352 ? PREGAP_SECTORS : ISO_SESSION_START;
  const sectorCount = Math.floor(data.byteLength / sectorSize); // trailing partial dropped
  const sectors: Uint8Array[] = [];
  for (let i = 0; i < sectorCount; i++) {
    sectors.push(data.subarray(i * sectorSize, (i + 1) * sectorSize));
  }
  const msfToOffset = (m: number, s: number, f: number): number => {
    const sectorIndex = Math.min(Math.max(lbaOf(m, s, f) - discStart, 0), sectorCount - 1);
    return sectorIndex * sectorSize;
  };
  return { sectors, sectorSize, msfToOffset };
}
