/**
 * PS-X EXE loader — mirrors load_psexe @0x433920 header contract:
 *   8s magic ("PS-X EXE"), 8s pad, u32 initial pc, u32 t_addr, u32 t_size,
 *   then payload at offset 0x800.
 * Verified against ePSXe docs (apps/docs) and the decompiled loader.
 */
import { RAM_SIZE } from "../memory";

export interface PsExe {
  pc0: number; // entry point
  t_addr: number; // load address (RAM)
  t_size: number; // payload bytes
  data: Uint8Array; // payload, exactly t_size bytes
}

const MAGIC = "PS-X EXE";

export function parsePsExe(bytes: Uint8Array): PsExe {
  if (bytes.byteLength < 0x800) throw new Error("PS-EXE too small (<2048 bytes header)");
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`bad magic "${magic}" (want "PS-X EXE")`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pc0 = dv.getUint32(0x10, true);
  // Real EXE headers use virtual t_addr (0x80010000 KUSEG base, or 0x8018xxxx
  // on 8MiB dev units). load_psexe normalizes into RAM; we accept both forms.
  const t_addr_va = dv.getUint32(0x18, true);
  const t_size = dv.getUint32(0x1c, true);
  const t_addr = t_addr_va & 0x1f_ffff; // RAM physical (mirror mask)
  if (t_size === 0 || t_addr + t_size > RAM_SIZE) {
    throw new Error(`bad segment: t_addr=0x${t_addr.toString(16)} t_size=0x${t_size.toString(16)}`);
  }
  const data = bytes.slice(0x800, 0x800 + t_size);
  if (data.byteLength !== t_size) throw new Error("truncated payload");
  return { pc0, t_addr, t_size, data };
}

export function loadIntoRam(mem: { ram: Uint8Array }, exe: PsExe): void {
  mem.ram.set(exe.data, exe.t_addr & 0x1f_ffff); // RAM mirrors: load at physical offset
}
