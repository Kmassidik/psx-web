import { describe, expect, test } from "bun:test";
import { readIsoFile } from "../src/core/loader/iso9660";

function sector(user?: Uint8Array): Uint8Array {
  const raw = new Uint8Array(2352);
  if (user) raw.set(user, 24);
  return raw;
}

function record(data: Uint8Array, offset: number, lba: number, size: number, directory: boolean, name: string): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nameBytes = new TextEncoder().encode(name);
  const length = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
  data[offset] = length;
  view.setUint32(offset + 2, lba, true);
  view.setUint32(offset + 10, size, true);
  data[offset + 25] = directory ? 2 : 0;
  data[offset + 32] = nameBytes.length;
  data.set(nameBytes, offset + 33);
  return offset + length;
}

function fixture(): (lba: number) => Uint8Array | undefined {
  const pvd = new Uint8Array(2048);
  pvd[0] = 1;
  pvd.set(new TextEncoder().encode("CD001"), 1);
  record(pvd, 156, 22, 2048, true, "\x00");
  const root = new Uint8Array(2048);
  record(root, 0, 30, 2048, true, "B");
  const b = new Uint8Array(2048);
  record(b, 0, 40, 4, false, "EXTREME3.EXE;1");
  const game = new Uint8Array(2048);
  game.set(new TextEncoder().encode("TEST"));
  const sectors = new Map<number, Uint8Array>([
    [16, sector(pvd)], [22, sector(root)], [30, sector(b)], [40, sector(game)],
  ]);
  return (lba) => sectors.get(lba - 150);
}

describe("ISO9660 BIOS file lookup", () => {
  test("resolves nested versioned paths and returns exact file bytes", () => {
    const bytes = readIsoFile(fixture(), "cdrom:\\B\\EXTREME3.EXE;1");
    expect(bytes).toBeDefined();
    expect(new TextDecoder().decode(bytes)).toBe("TEST");
  });

  test("missing files return undefined", () => {
    expect(readIsoFile(fixture(), "cdrom:\\B\\MISSING.EXE;1")).toBeUndefined();
  });
});
