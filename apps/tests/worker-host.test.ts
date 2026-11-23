import { describe, expect, test } from "bun:test";
import { EmulatorWorkerRuntime } from "../src/core/emulator-worker";
import { MAX_PENDING_HOST_REQUESTS } from "../src/core/emulator-worker-protocol";
import { buildHelloExe } from "../src/core/hello-exe";
import {
  WorkerHost, type EmulatorWorkerLike, type HostAudioChunk, type HostFrame,
} from "../src/ui/worker-host";

class LoopbackWorker implements EmulatorWorkerLike {
  onmessage: EmulatorWorkerLike["onmessage"] = null;
  onmessageerror: EmulatorWorkerLike["onmessageerror"] = null;
  onerror: EmulatorWorkerLike["onerror"] = null;
  terminated = false;
  private readonly runtime = new EmulatorWorkerRuntime({
    postMessage: (event) => this.onmessage?.({ data: event } as MessageEvent),
  });

  postMessage(message: Parameters<EmulatorWorkerLike["postMessage"]>[0]): void {
    this.runtime.handle(message);
  }

  terminate(): void { this.terminated = true; }
}

class SilentWorker implements EmulatorWorkerLike {
  onmessage: EmulatorWorkerLike["onmessage"] = null;
  onmessageerror: EmulatorWorkerLike["onmessageerror"] = null;
  onerror: EmulatorWorkerLike["onerror"] = null;
  terminated = false;
  postMessage(): void {}
  terminate(): void { this.terminated = true; }
}

describe("WorkerHost", () => {
  test("runs single-flight batches and delivers transferable frames/audio outside React", async () => {
    const worker = new LoopbackWorker();
    const frames: HostFrame[] = [];
    const audio: HostAudioChunk[] = [];
    const host = new WorkerHost(worker, {
      onFrame: (frame) => frames.push(frame),
      onAudio: (chunk) => audio.push(chunk),
    });
    const source = buildHelloExe().bytes;
    const boot = await host.boot(source.buffer, "hello.exe", "exe");
    expect(boot.source).toBe("exe");
    expect(host.isRunning).toBe(true);

    const first = host.runBatch(4);
    const duplicate = host.runBatch(4);
    await expect(duplicate).resolves.toBeNull();
    const run = await first;
    expect(run!.slices).toBe(4);
    expect(frames.length).toBe(1);
    expect(frames[0]!.rgba).toBeInstanceOf(Uint8Array);
    expect(audio[0]!.left).toBeInstanceOf(Float32Array);
    expect(audio[0]!.left.length).toBe(audio[0]!.frames);
    expect(host.pendingRequestCount).toBe(0);

    await host.pause();
    expect(host.state).toBe("paused");
    await expect(host.runBatch(1)).resolves.toBeNull();
    await host.resume();
    const saved = await host.saveState();
    await host.loadState(saved);
    expect(host.isRunning).toBe(true);
    const exported = await host.memoryCard(0, "export");
    expect(exported!.byteLength).toBe(128 * 1024);
    await host.reset();
    await host.stop();
    expect(host.state).toBe("idle");
    await host.dispose();
    expect(worker.terminated).toBe(true);
    expect(host.isDisposed).toBe(true);
  });

  test("caps outstanding RPCs and disposes all pending requests", async () => {
    const worker = new SilentWorker();
    const host = new WorkerHost(worker);
    const source = buildHelloExe().bytes;
    const requests: Promise<unknown>[] = [host.boot(source.buffer, "hello.exe").catch((error) => error)];
    for (let i = 1; i < MAX_PENDING_HOST_REQUESTS; i++) {
      requests.push(host.saveState().catch((error) => error));
    }
    expect(host.pendingRequestCount).toBe(MAX_PENDING_HOST_REQUESTS);
    await expect(host.saveState()).rejects.toMatchObject({ code: "queue-limit" });
    await host.dispose();
    await Promise.all(requests);
    expect(host.pendingRequestCount).toBe(0);
    expect(worker.terminated).toBe(true);
  });
});
