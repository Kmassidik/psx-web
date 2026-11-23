import type { SectorProvider } from "./iso9660";

/** MDS/MDF raw 2448-byte sectors → CD 2352-byte sectors (96-byte subchannel removed). */
export function createMdfSectorProvider(bytes: Uint8Array): SectorProvider {
  if (bytes.byteLength === 0 || bytes.byteLength % 2448 !== 0) {
    throw new Error("MDF length must be a nonzero multiple of 2448 bytes");
  }
  return (lba: number): Uint8Array | undefined => {
    const sector = lba - 150;
    if (sector < 0 || (sector + 1) * 2448 > bytes.byteLength) return undefined;
    return bytes.subarray(sector * 2448, sector * 2448 + 2352);
  };
}
