/**
 * WebAudio sink for the SPU mix output. Chief-owned integration piece:
 * buffers SPU float output into an AudioWorklet-compatible ring via
 * ScriptProcessor-free approach: pre-render into an AudioBuffer queue.
 * Simple model (Phase 3): one AudioBufferSourceNode per frame batch.
 */
export class SpuAudioSink {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private readonly sampleRate = 44100;

  /** Push one mixed stereo frame (64 samples @44.1kHz per SPU tick). */
  ensureStarted(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.nextTime = this.ctx.currentTime;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Queue `frames` of SPU output [L,R] pairs. Returns false if no ctx. */
  push(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): boolean {
    if (!this.ctx) return false;
    const n = left.length;
    const buf = this.ctx.createBuffer(2, n, this.sampleRate);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(Math.max(this.nextTime, this.ctx.currentTime));
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime) + n / this.sampleRate;
    return true;
  }
}
