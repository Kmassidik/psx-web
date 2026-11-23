import { useEffect, useRef, type RefObject } from "react";
import type { DisplayScale } from "../state/config";

const NATIVE_WIDTH = 640;
const NATIVE_HEIGHT = 480;

interface DisplaySurfaceProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  scaleMode: DisplayScale;
  bilinear: boolean;
  loaded: boolean;
  onOpen: () => void;
  onResize: () => void;
}

/** Owns presentation pixels only; the emulator always renders at native size. */
export function DisplaySurface({ canvasRef, scaleMode, bilinear, loaded, onOpen, onResize }: DisplaySurfaceProps) {
  const areaRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const resizeCallback = useRef(onResize);
  resizeCallback.current = onResize;

  useEffect(() => {
    const area = areaRef.current;
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!area || !shell || !canvas) return;
    let dprQuery: MediaQueryList | null = null;

    const resize = () => {
      const style = getComputedStyle(area);
      const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const availableWidth = Math.max(1, area.clientWidth - horizontalPadding - 2);
      const availableHeight = Math.max(1, area.clientHeight - verticalPadding - 2);
      let width = availableWidth;
      let height = availableHeight;
      if (scaleMode !== "stretch") {
        const fitScale = Math.min(availableWidth / NATIVE_WIDTH, availableHeight / NATIVE_HEIGHT);
        const scale = scaleMode === "integer" && fitScale >= 1 ? Math.max(1, Math.floor(fitScale)) : fitScale;
        width = NATIVE_WIDTH * scale;
        height = NATIVE_HEIGHT * scale;
      }
      shell.style.width = `${Math.max(1, Math.floor(width))}px`;
      shell.style.height = `${Math.max(1, Math.floor(height))}px`;

      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || Math.max(1, width - 2);
      const cssHeight = canvas.clientHeight || Math.max(1, height - 2);
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      canvas.style.imageRendering = bilinear ? "auto" : "pixelated";
      resizeCallback.current();
    };

    const watchDpr = () => {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    };
    const onDprChange = () => {
      resize();
      watchDpr();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(area);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    document.addEventListener("fullscreenchange", resize);
    if (typeof window.matchMedia === "function") watchDpr();
    resize();
    return () => {
      observer?.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      document.removeEventListener("fullscreenchange", resize);
    };
  }, [bilinear, canvasRef, scaleMode]);

  return (
    <main
      ref={areaRef}
      className="display-area"
      onClick={loaded ? undefined : onOpen}
      onKeyDown={(event) => {
        if (!loaded && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
      role={loaded ? undefined : "button"}
      tabIndex={0}
      aria-label={loaded ? "Emulator display" : "Open a PS-X EXE or MDF"}
    >
      <div ref={shellRef} className="canvas-shell" data-scale-mode={scaleMode}>
        <canvas
          ref={canvasRef}
          width={NATIVE_WIDTH}
          height={NATIVE_HEIGHT}
          className="game-canvas"
          role="img"
          aria-label="PlayStation display, rendered at native resolution"
        />
        {!loaded && (
          <div className="display-hint" aria-hidden="true">
            <span className="epsxe-wordmark">ePSXe</span>
            <span>Drop a PS-X EXE or MDF here, or click to choose a file</span>
          </div>
        )}
      </div>
    </main>
  );
}
