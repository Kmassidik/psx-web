/** Minimal ISO9660 reader for BIOS file calls over raw 2352-byte CD sectors. */
export type SectorProvider = (lba: number) => Uint8Array | undefined;

const USER_SIZE = 2048;
const DISC_PREGAP = 150;

function readSector(provider: SectorProvider, lba: number): Uint8Array | undefined {
  const raw = provider(lba + DISC_PREGAP);
  return raw && raw.length >= 24 + USER_SIZE ? raw.subarray(24, 24 + USER_SIZE) : undefined;
}

function readExtent(provider: SectorProvider, lba: number, size: number): Uint8Array | undefined {
  const result = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += USER_SIZE) {
    const sector = readSector(provider, lba + offset / USER_SIZE);
    if (!sector) return undefined;
    result.set(sector.subarray(0, Math.min(USER_SIZE, size - offset)), offset);
  }
  return result;
}

interface DirectoryRecord {
  lba: number;
  size: number;
  directory: boolean;
  name: string;
}

function records(data: Uint8Array): DirectoryRecord[] {
  const result: DirectoryRecord[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset + 34 <= data.length;) {
    const length = data[offset]!;
    if (length === 0) {
      offset = (offset + USER_SIZE) & ~(USER_SIZE - 1);
      continue;
    }
    if (offset + length > data.length) break;
    const nameLength = data[offset + 32]!;
    const rawName = String.fromCharCode(...data.subarray(offset + 33, offset + 33 + nameLength));
    result.push({
      lba: view.getUint32(offset + 2, true),
      size: view.getUint32(offset + 10, true),
      directory: (data[offset + 25]! & 2) !== 0,
      name: rawName === "\x00" || rawName === "\x01" ? rawName : rawName.split(";")[0]!.toUpperCase(),
    });
    offset += length;
  }
  return result;
}

/** Resolve a CDROM path such as `cdrom:\B\EXTREME3.EXE;1` to its file bytes. */
export function readIsoFile(provider: SectorProvider, path: string): Uint8Array | undefined {
  const pvd = readSector(provider, 16);
  if (!pvd || pvd[0] !== 1 || String.fromCharCode(...pvd.subarray(1, 6)) !== "CD001") return undefined;
  const view = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength);
  let lba = view.getUint32(156 + 2, true);
  let size = view.getUint32(156 + 10, true);
  const parts = path.replace(/^cdrom:\\?/i, "").split("\\").filter(Boolean);
  if (parts.length === 0) return undefined;

  for (let index = 0; index < parts.length; index++) {
    const directory = readExtent(provider, lba, size);
    if (!directory) return undefined;
    const wanted = parts[index]!.split(";")[0]!.toUpperCase();
    const record = records(directory).find((candidate) => candidate.name === wanted);
    if (!record) return undefined;
    if (index === parts.length - 1) {
      return record.directory ? undefined : readExtent(provider, record.lba, record.size);
    }
    if (!record.directory) return undefined;
    lba = record.lba;
    size = record.size;
  }
  return undefined;
}
