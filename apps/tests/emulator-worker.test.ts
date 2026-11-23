import { describe, expect, test } from "bun:test";
import { EmulatorWorkerRuntime, type EmulatorWorkerScope } from "../src/core/emulator-worker";
import type { EmulatorWorkerEvent, EmulatorWorkerResult } from "../src/core/emulator-worker-protocol";
import { buildHelloExe } from "../src/core/hello-exe";
import { Machine } from "../src/core/machine";
import { MEMORY_CARD_SIZE } from "../src/core/memory-card";

interface Posted {
  event: EmulatorWorkerEvent;
  transfer: Transferable[] | undefined;
}

function fixture() {
  const posted: Posted[] = [];
  const machines: Machine[] = [];
  const scope: EmulatorWorkerScope = {
    postMessage(event, transfer) { posted.push({ event, transfer }); },
  };
  const runtime = new EmulatorWorkerRuntime(scope, () => {
    const machine = new Machine();
    machines.push(machine);
    return machine;
  });
  return { posted, machines, runtime };
}

function result(posted: Posted[], index = -1): EmulatorWorkerResult {
  const event = posted.at(index)!.event;
  expect(event.type).toBe("response");
  if (event.type !== "response") throw new Error("expected response");
  return event.result;
}

function directoryRecord(data: Uint8Array, offset: number, lba: number, size: number, directory: boolean, name: string): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const encoded = new TextEncoder().encode(name);
  const length = 33 + encoded.length + (encoded.length % 2 === 0 ? 1 : 0);
  data[offset] = length;
  view.setUint32(offset + 2, lba, true);
  view.setUint32(offset + 10, size, true);
  data[offset + 25] = directory ? 2 : 0;
  data[offset + 32] = encoded.length;
  data.set(encoded, offset + 33);
  return offset + length;
}

function commercialMdf(frontend: Uint8Array, game: Uint8Array): ArrayBuffer {
  const sectors = Array.from({ length: 23 }, () => new Uint8Array(2448));
  const user = (lba: number): Uint8Array => sectors[lba]!.subarray(24, 24 + 2048);
  const pvd = user(16);
  pvd[0] = 1;
  pvd.set(new TextEncoder().encode("CD001"), 1);
  directoryRecord(pvd, 156, 17, 2048, true, "\x00");
  const root = user(17);
  let offset = directoryRecord(root, 0, 18, frontend.length, false, "FE.EXE;1");
  directoryRecord(root, offset, 20, game.length, false, "GAME.EXE;1");
  user(18).set(frontend.subarray(0, 2048));
  user(19).set(frontend.subarray(2048));
  user(20).set(game.subarray(0, 2048));
  user(21).set(game.subarray(2048));
  const image = new Uint8Array(sectors.length * 2448);
  sectors.forEach((sector, index) => image.set(sector, index * 2448));
  return image.buffer;
}

describe("emulator worker protocol", () => {
  test("owns bounded execution, native/high-res frames, input, state, cards, reset, and disposal", () => {
    const { posted, machines, runtime } = fixture();
    const source = buildHelloExe().bytes;
    runtime.handle({ type: "boot", id: 1, name: "hello.exe", mode: "exe", buffer: source.buffer });
    expect(result(posted)).toMatchObject({ kind: "boot", source: "exe", lifecycle: "running" });
    expect(posted[0]!.transfer).toEqual([]);

    runtime.handle({ type: "run", id: 2, slices: 171 });
    expect(posted.at(-1)!.event).toMatchObject({ type: "error", id: 2, code: "bad-request" });
    runtime.handle({
      type: "input", id: 0, revision: 7,
      state: [
        { buttons: 0xbfff, axes: [1, -1, 0.5, 0], connected: true, analog: true },
        { buttons: 0xffff, axes: [0, 0, 0, 0], connected: true, analog: false },
      ],
    });
    expect(machines[0]!.pads.pad1).toBe(0xbfff);
    expect(posted.at(-1)!.event).toEqual({ type: "input-ack", revision: 7 });

    runtime.handle({ type: "run", id: 3, slices: 4, frame: true });
    const native = result(posted);
    expect(native.kind).toBe("run");
    if (native.kind !== "run") throw new Error("expected run");
    expect(native.slices).toBe(4);
    expect(native.frame!.scale).toBe(1);
    expect(native.audio!.frames).toBe(4 * Math.floor(20_000 / 768));
    expect(native.audio!.left.byteLength).toBe(native.audio!.frames * 4);
    expect(native.audio!.right.byteLength).toBe(native.audio!.frames * 4);
    expect(posted.at(-1)!.transfer).toContain(native.frame!.rgba);

    runtime.handle({ type: "frame", id: 4, scale: 2 });
    const scaled = result(posted);
    if (scaled.kind !== "frame") throw new Error("expected frame");
    expect(scaled.frame.scale).toBe(2);
    expect(scaled.frame.width).toBe(native.frame!.width * 2);

    runtime.handle({ type: "save-state", id: 5 });
    const saved = result(posted);
    if (saved.kind !== "save-state") throw new Error("expected state");
    expect(saved.bytes.byteLength).toBeGreaterThan(1024);
    runtime.handle({ type: "pause", id: 6 });
    expect(machines[0]!.pads.pad1).toBe(0xffff);
    runtime.handle({ type: "run", id: 7, slices: 1 });
    expect(posted.at(-1)!.event).toMatchObject({ type: "error", code: "wrong-state" });
    runtime.handle({ type: "load-state", id: 8, bytes: saved.bytes });
    expect(result(posted)).toEqual({ kind: "lifecycle", lifecycle: "running" });

    runtime.handle({ type: "memory-card", id: 9, port: 0, operation: "export" });
    const card = result(posted);
    if (card.kind !== "memory-card") throw new Error("expected card");
    expect(card.image!.byteLength).toBe(MEMORY_CARD_SIZE);
    runtime.handle({ type: "memory-card", id: 10, port: 0, operation: "detach" });
    expect(result(posted)).toMatchObject({ kind: "memory-card", attached: false });

    runtime.handle({ type: "reset", id: 11 });
    expect(result(posted)).toMatchObject({ kind: "boot", lifecycle: "running" });
    expect(machines.length).toBe(2);
    runtime.handle({ type: "stop", id: 12 });
    runtime.handle({ type: "frame", id: 13 });
    expect(posted.at(-1)!.event).toMatchObject({ type: "error", code: "no-machine" });
    runtime.handle({ type: "dispose", id: 14 });
    expect(result(posted)).toEqual({ kind: "disposed" });
    expect(runtime.disposed).toBe(true);
  });

  test("MDF boot runs FE before GAME and retains one shared sector source", () => {
    const { posted, runtime } = fixture();
    const frontend = buildHelloExe(0x00_00_ff).bytes;
    const game = buildHelloExe(0x00_ff_00).bytes;
    const image = commercialMdf(frontend, game);
    runtime.handle({ type: "boot", id: 1, name: "game.mdf", mode: "auto", buffer: image });
    expect(result(posted)).toMatchObject({ kind: "boot", source: "mdf", lifecycle: "running" });
    runtime.handle({ type: "run", id: 2, slices: 4, frame: true });
    const run = result(posted);
    if (run.kind !== "run") throw new Error("expected run");
    const rgba = new Uint8Array(run.frame!.rgba);
    expect(rgba[1]).toBe(255); // GAME's green, not FE's red.
    expect(rgba[0]).toBe(0);
  });
});
