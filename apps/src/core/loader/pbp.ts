/**
 * PBP (PlayStation Portable eboot) loader — enough to find the PSAR blob,
 * which is where a PS1 disc image (or a PSN-style Virtual disc) lives.
 *
 * Header (little-endian):
 *   0x00  8s "PBP" + NUL-padded version string
 *   0x08  8 x u32 offsets: param.sfo, icon0, icon1, pic0, pic1, snd0,
 *                          DATA.PSP, DATA.PSAR
 * A minimal PBP (headless PSX eboot) may only carry PSAR non-zero; the other
 * seven entries are 0 when that file is absent (no$psx layout).
 * PSAR offset is what matters for us: the ISO starts there.
 */
export interface Pbp {
  psarOffset: number;
  iconOffset: number; // icon0.png start (0 when absent)
}

const MAGIC = "PBP";

export function parsePbp(data: Uint8Array): Pbp | undefined {
  if (data.byteLength < 0x28) return undefined;
  const magic = new TextDecoder("ascii").decode(data.subarray(0, 3));
  if (magic !== MAGIC) return undefined;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 8-entry offset table at 0x08; entry 0=param.sfo, 1=icon0, 6=DATA.PSP, 7=DATA.PSAR
  const psarOffset = dv.getUint32(0x08 + 7 * 4, true);
  const iconOffset = dv.getUint32(0x08 + 1 * 4, true);
  if (psarOffset === 0) return undefined; // not a PS1 eboot
  return { psarOffset, iconOffset };
}
