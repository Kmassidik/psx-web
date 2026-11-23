import type { HostFrame } from "./worker-host";

/** Canvas-only frame presentation; transferred pixels never enter React state. */
export class WorkerFramePresenter {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private readonly nativeCanvas = document.createElement("canvas");
  private readonly nativeContext = this.nativeCanvas.getContext("2d");
  private image: ImageData | null = null;

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.context = canvas?.getContext("2d") ?? null;
  }

  present(frame: HostFrame, bilinear: boolean): void {
    const native = this.nativeContext;
    if (!native) return;
    if (this.nativeCanvas.width !== frame.width || this.nativeCanvas.height !== frame.height) {
      this.nativeCanvas.width = frame.width;
      this.nativeCanvas.height = frame.height;
      this.image = native.createImageData(frame.width, frame.height);
    }
    this.image ??= native.createImageData(frame.width, frame.height);
    this.image.data.set(frame.rgba);
    native.putImageData(this.image, 0, 0);
    this.redraw(bilinear);
  }

  redraw(bilinear: boolean): void {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context || this.nativeCanvas.width === 0 || this.nativeCanvas.height === 0) return;
    context.imageSmoothingEnabled = bilinear;
    context.drawImage(this.nativeCanvas, 0, 0, canvas.width, canvas.height);
  }

  clear(): void {
    const canvas = this.canvas;
    if (canvas && this.context) this.context.clearRect(0, 0, canvas.width, canvas.height);
    this.nativeCanvas.width = 0;
    this.nativeCanvas.height = 0;
    this.image = null;
  }
}
