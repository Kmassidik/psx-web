import { describe, expect, test } from "bun:test";
import { createMdfSectorProvider } from "../src/core/loader/mdf";

describe("MDF sector provider", () => {
  test("maps disc LBA 150 to raw sector zero without subchannel data", () => {
    const bytes = new Uint8Array(2448);
    bytes[0] = 0xaa;
    bytes[2351] = 0xbb;
    bytes[2352] = 0xcc;
    const provider = createMdfSectorProvider(bytes);
    const sector = provider(150)!;
    expect(sector.length).toBe(2352);
    expect(sector[0]).toBe(0xaa);
    expect(sector[2351]).toBe(0xbb);
    expect(provider(149)).toBeUndefined();
    expect(provider(151)).toBeUndefined();
  });

  test("rejects malformed image lengths", () => {
    expect(() => createMdfSectorProvider(new Uint8Array(10))).toThrow(/2448/);
  });
});
