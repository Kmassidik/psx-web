/**
 * Minimal kernel-call surface for BIOS-free PS-EXE boots (A/B/C-call stubs).
 * The reference binary's BiosHLE mode boots games without a BIOS dump; this
 * mirrors that surface at the syscall level: games calling A(blah)/B(blah)
 * through the 0xA0/0xB0/0xC0 vectors get stub success instead of a crash.
 * Full per-call emulation is a later ticket; this is the crash-shield.
 */
export const SYSCALL_TABLE: Record<number, { name: string; ret: number }> = {
  // B-calls (file/exec) most games probe at boot:
  0x00: { name: "B_open", ret: 0xdead_0001 }, // fd (bogus but non-zero)
  0x01: { name: "B_lseek", ret: 0 },
  0x02: { name: "B_read", ret: 0 },
  0x03: { name: "B_write", ret: 0 },
  0x07: { name: "B_exit", ret: 0 },
  0x08: { name: "B_chdir", ret: 0 },
  0x25: { name: "B_FlushCache", ret: 0 },
  0x2f: { name: "B_InitPAD", ret: 0 },
  0x38: { name: "B_StartDevice", ret: 0 },
  0x44: { name: "B_ChangeClearPAD", ret: 0 },
  0x4a: { name: "B_SysEnqIntRP", ret: 0 },
  0x4b: { name: "B_SysDeqIntRP", ret: 0 },
  0x4c: { name: "B_get_free_EvCB", ret: 0 },
  0x4d: { name: "B_get_free_TCB", ret: 0 },
  0x4e: { name: "B_EnqueueEvent", ret: 0 },
  0x4f: { name: "B_DequeueEvent", ret: 0 },
  0x50: { name: "B_OpenEvent", ret: 1 },
  0x51: { name: "B_CloseEvent", ret: 0 },
  0x52: { name: "B_WaitEvent", ret: 1 },
  0x5b: { name: "B_ReturnFromException", ret: 0 },
  0x63: { name: "B_FlushCache", ret: 0 },
};

/** Returns the fake success value for a syscall, or undefined if unknown. */
export function hleSyscall(t: number, a: number): number | undefined {
  if (t === 0xb0) return SYSCALL_TABLE[a]?.ret;
  if (t === 0xa0) return 1; // graphics stubs: pretend success
  if (t === 0xc0) return 0; // C-calls: low-level stubs
  return undefined;
}
