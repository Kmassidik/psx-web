/**
 * Minimal WebAssembly binary-format encoder — the byte stream the dynarec
 * translator feeds to `new WebAssembly.Module(bytes)`.
 *
 * Binary layout emitted (wasm MVP):
 *   header:  magic `\0asm` (00 61 73 6D) + version 1 (01 00 00 00)
 *   section 1  types    — vec of func types: 0x60 <params> <results>
 *   section 2  imports  — func (kind 0x00 + typeidx), memory (kind 0x02 + limits)
 *   section 3  funcs    — vec of type indices for defined functions
 *   section 7  exports  — name + kind (0x00 func / 0x02 mem) + index
 *   section 10 code     — vec of bodies: u32 size, local groups, expr, 0x0b
 * Sections are written in ascending id order; each is id byte + u32 LEB size.
 * All integers are LEB128: unsigned for indices/sizes, signed for i32.const.
 *
 * Opcode subset (each emitted site in translator.ts references these):
 *   0x00 unreachable        0x04 if (void blocktype 0x40)
 *   0x0b end                0x0d br_if
 *   0x10 call               0x1a drop
 *   0x20 local.get          0x21 local.set         0x22 local.tee
 *   0x28 i32.load           0x36 i32.store         (align=2 log2(4), offset imm)
 *   0x41 i32.const
 *   0x45 eqz  0x46 eq  0x47 ne  0x48 lt_s  0x49 lt_u  0x4a gt_s
 *   0x4c le_s  0x4e ge_s
 *   0x6a add  0x6b sub  0x6c mul  0x71 and  0x72 or  0x73 xor
 *   0x74 shl  0x75 shr_s  0x76 shr_u
 */

/** Value type: i32. */
export const I32 = 0x7f;

/** Wasm opcodes used by the translator (hex = binary encoding). */
export const OP = {
  UNREACHABLE: 0x00,
  IF: 0x04, // followed by blocktype (0x40 = void)
  END: 0x0b,
  BR_IF: 0x0d, // + u32 depth
  CALL: 0x10, // + u32 func index
  DROP: 0x1a,
  LOCAL_GET: 0x20, // + u32 local index
  LOCAL_SET: 0x21,
  LOCAL_TEE: 0x22,
  I32_LOAD: 0x28, // + align, offset
  I32_STORE: 0x36,
  I32_CONST: 0x41, // + sleb128
  I32_EQZ: 0x45,
  I32_EQ: 0x46,
  I32_NE: 0x47,
  I32_LT_S: 0x48,
  I32_LT_U: 0x49,
  I32_GT_S: 0x4a,
  I32_LE_S: 0x4c,
  I32_GE_S: 0x4e,
  I32_ADD: 0x6a,
  I32_SUB: 0x6b,
  I32_MUL: 0x6c,
  I32_AND: 0x71,
  I32_OR: 0x72,
  I32_XOR: 0x73,
  I32_SHL: 0x74,
  I32_SHR_S: 0x75,
  I32_SHR_U: 0x76,
} as const;

/** Append unsigned LEB128. */
export function uleb(out: number[], v: number): void {
  let x = v >>> 0;
  do {
    let b = x & 0x7f;
    x >>>= 7;
    if (x !== 0) b |= 0x80;
    out.push(b);
  } while (x !== 0);
}

/** Append signed LEB128 (two's-complement, as i32.const takes). */
export function sleb(out: number[], v: number): void {
  let x = v | 0;
  for (;;) {
    const b = x & 0x7f;
    x >>= 7;
    if ((x === 0 && (b & 0x40) === 0) || (x === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return;
    }
    out.push(b | 0x80);
  }
}

/**
 * One module under construction. Call header(), then begin/end around each
 * section in ascending id order, then finish().
 */
export class WasmEmitter {
  private out: number[] = []; // header + completed sections
  private sec: number[] = []; // current section payload
  private secId = -1;

  header(): void {
    this.out.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  }

  /** Start a section; payload bytes go to `byte`/`u32`/... until end(). */
  begin(id: number): void {
    this.sec = [];
    this.secId = id;
  }

  /** Close the section: id byte + u32 payload size + payload. */
  end(): void {
    this.out.push(this.secId);
    uleb(this.out, this.sec.length);
    for (const b of this.sec) this.out.push(b);
    this.secId = -1;
  }

  byte(...bs: number[]): void {
    for (const b of bs) this.sec.push(b);
  }

  raw(bytes: number[]): void {
    for (const b of bytes) this.sec.push(b);
  }

  /** Unsigned LEB128 into the current section. */
  u32(v: number): void {
    uleb(this.sec, v);
  }

  /** Signed LEB128 into the current section. */
  i32(v: number): void {
    sleb(this.sec, v);
  }

  /** Length-prefixed name (ASCII names only: env/memory/run/read32/...). */
  name(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.sec.push(s.charCodeAt(i));
  }

  /** One func type: 0x60 <vec params> <vec results>. */
  type(params: number[], results: number[]): void {
    this.byte(0x60);
    this.u32(params.length);
    for (const p of params) this.byte(p);
    this.u32(results.length);
    for (const r of results) this.byte(r);
  }

  /** Imported function: names + kind 0x00 + type index. */
  importFunc(mod: string, field: string, typeIdx: number): void {
    this.name(mod);
    this.name(field);
    this.byte(0x00);
    this.u32(typeIdx);
  }

  /** Imported memory: names + kind 0x02 + limits (flags 0x00 = min only). */
  importMemory(mod: string, field: string, minPages: number): void {
    this.name(mod);
    this.name(field);
    this.byte(0x02, 0x00);
    this.u32(minPages);
  }

  /** Export entry: name + kind + index. */
  exportName(name: string, kind: number, idx: number): void {
    this.name(name);
    this.byte(kind);
    this.u32(idx);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
