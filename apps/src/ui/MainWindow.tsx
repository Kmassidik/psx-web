/** Worker-backed PS1 window; React owns controls, never emulator memory or frames. */
import { useCallback, useEffect, useRef, useState } from "react";
import { SpuAudioSink } from "../core/spu-audio";
import { bindAudioUnlock } from "./audio";
import { loadStoredSaveState, storeSaveState } from "./save-state-storage";
import { WorkerGamepadInput } from "./worker-gamepad-input";
import { WorkerFramePresenter } from "./worker-presentation";
import { loadStoredMemoryCard } from "./memory-card-storage";
import { WorkerHost, type WorkerHostError } from "./worker-host";
import { PAD_BUTTONS, type PsxConfig } from "../state/config";
import { getState, setConfig, setState, useApp } from "./store";
import { DisplaySurface } from "./DisplaySurface";
import { MainMenu, type DialogName, type FileMode } from "./MainMenu";
import { VideoConfigDialog } from "./dialogs/VideoConfigDialog";
import { GamepadConfigDialog } from "./dialogs/GamepadConfigDialog";
import { MemcardDialog } from "./dialogs/MemcardDialog";
import { Dialog } from "./dialogs/Dialog";

function rendererScale(renderer: PsxConfig["Renderer"]): 1 | 2 | 4 {
  return renderer === "2x" ? 2 : renderer === "4x" ? 4 : 1;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function storedMemoryCard(name: string): Promise<ArrayBuffer | undefined> {
  try {
    const bytes = await loadStoredMemoryCard(name);
    return bytes ? exactBuffer(bytes) : undefined;
  } catch {
    return undefined; // A formatted worker-owned card remains usable without IndexedDB.
  }
}

export function MainWindow() {
  const run = useApp((s) => s.run);
  const statusLine = useApp((s) => s.statusLine);
  const lastError = useApp((s) => s.lastError);
  const config = useApp((s) => s.config);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [gamepadPort, setGamepadPort] = useState<1 | 2>(1);
  const [fullscreen, setFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMode = useRef<FileMode>("auto");
  const stateSlotRef = useRef(1);
  const gamepadInputRef = useRef<WorkerGamepadInput | null>(null);
  if (!gamepadInputRef.current) gamepadInputRef.current = new WorkerGamepadInput();
  const gamepadInput = gamepadInputRef.current;
  const presenterRef = useRef<WorkerFramePresenter | null>(null);
  if (!presenterRef.current) presenterRef.current = new WorkerFramePresenter();
  const presenter = presenterRef.current;
  const configRef = useRef<PsxConfig>(config);
  const rafRef = useRef(0);
  const loopGenerationRef = useRef(0);
  const operationRef = useRef(0);
  const audioRef = useRef<SpuAudioSink | null>(null);
  if (!audioRef.current) audioRef.current = new SpuAudioSink({ volume: config.AudioVolume });
  const audio = audioRef.current;
  const [muted, setMuted] = useState(false);
  const redrawRef = useRef<() => void>(() => {});
  const workerErrorRef = useRef<(error: WorkerHostError) => void>(() => {});
  const hostRef = useRef<WorkerHost | null>(null);
  configRef.current = config;

  const cancelLoop = useCallback(() => {
    loopGenerationRef.current++;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  if (!hostRef.current) {
    hostRef.current = WorkerHost.create({
      onFrame: (frame) => presenter.present(frame, configRef.current.BilinearFilter),
      onAudio: (chunk) => { audio.push(chunk.left, chunk.right); },
      onRumble: (rumble) => gamepadInput.applyRumble(rumble),
      onError: (error) => workerErrorRef.current(error),
    });
  }
  const host = hostRef.current;

  const releasePads = useCallback(() => {
    gamepadInput.release(host);
  }, [gamepadInput, host]);

  const redraw = useCallback(() => redrawRef.current(), []);

  const startLoop = useCallback((name: string) => {
    cancelLoop();
    if (!canvasRef.current || host.isDisposed) return;
    const generation = loopGenerationRef.current;
    let frames = 0;
    let lastFps = performance.now();
    let lastCycleTime = lastFps;
    redrawRef.current = () => presenter.redraw(configRef.current.BilinearFilter);

    const fail = (error: unknown) => {
      if (generation !== loopGenerationRef.current) return;
      cancelLoop();
      audio.pause();
      setState({ run: "error", lastError: `Emulation: ${String(error)}`, statusLine: "execution failed" });
    };
    void host.frame(rendererScale(configRef.current.Renderer)).catch(fail);

    const tick = () => {
      if (generation !== loopGenerationRef.current || getState().run !== "running") return;
      gamepadInput.poll(host, configRef.current);
      const now = performance.now();
      const elapsed = Math.min(100, Math.max(0, now - lastCycleTime));
      lastCycleTime = now;
      void host.tick(elapsed).then((result) => {
        if (generation !== loopGenerationRef.current || !result) return;
        frames++;
        if (!result.ok) {
          cancelLoop();
          audio.pause();
          setState({ run: "paused", statusLine: `paused ${name}` });
        }
      }).catch(fail);
      if (now - lastFps >= 1000) {
        const fps = configRef.current.ShowFPS ? ` · ${frames} fps` : "";
        setState({ statusLine: `running ${name}${fps}` });
        frames = 0;
        lastFps = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [audio, cancelLoop, gamepadInput, host, presenter]);

  const boot = useCallback(async (buf: ArrayBuffer, name: string, mode: FileMode) => {
    const operation = ++operationRef.current;
    cancelLoop();
    releasePads();
    audio.reset();
    void audio.resume();
    setLoaded(null);
    setState({ run: "loaded", lastError: "", statusLine: `loading ${name}` });
    const settings = configRef.current;
    try {
      const memoryCards = await Promise.all([
        storedMemoryCard(settings.Memcard1), storedMemoryCard(settings.Memcard2),
      ]) as [ArrayBuffer | undefined, ArrayBuffer | undefined];
      if (operation !== operationRef.current) return;
      const result = await host.boot(buf, name, mode, {
        dynarec: settings.Dynarec,
        renderer: rendererScale(settings.Renderer),
        frontendSlices: 300,
        memoryCards,
      });
      if (operation !== operationRef.current) return;
      setLoaded(name);
      setState({
        run: "running",
        lastError: "",
        statusLine: result.source === "bios" ? `BIOS ${name} loaded`
          : `running ${name} (${(result.payloadBytes / 1024).toFixed(0)} KiB)`,
      });
      startLoop(name);
    } catch (error) {
      if (operation !== operationRef.current) return;
      cancelLoop();
      redrawRef.current = () => {};
      presenter.clear();
      setLoaded(null);
      setState({ run: "error", lastError: `Boot: ${String(error)}`, statusLine: "load failed" });
    }
  }, [audio, cancelLoop, host, presenter, releasePads, startLoop]);

  const pause = useCallback(() => {
    if (getState().run !== "running" || !loaded) return;
    cancelLoop();
    releasePads();
    audio.pause();
    setState({ run: "paused", statusLine: `paused ${loaded}` });
    void host.pause().catch((error) => {
      setState({ run: "error", lastError: `Pause failed: ${String(error)}` });
    });
  }, [audio, cancelLoop, host, loaded, releasePads]);

  const resume = useCallback(async () => {
    if (getState().run !== "paused" || !loaded) return;
    const operation = ++operationRef.current;
    const name = loaded;
    setState({ run: "loaded", lastError: "", statusLine: `resuming ${name}` });
    try {
      await host.resume();
      if (operation !== operationRef.current) return;
      void audio.resume();
      setState({ run: "running", lastError: "", statusLine: `running ${name}` });
      startLoop(name);
    } catch (error) {
      if (operation === operationRef.current) setState({ run: "error", lastError: `Resume failed: ${String(error)}` });
    }
  }, [audio, host, loaded, startLoop]);

  const reset = useCallback(async () => {
    if (!loaded) return;
    const operation = ++operationRef.current;
    const name = loaded;
    cancelLoop();
    releasePads();
    audio.reset();
    void audio.resume();
    setLoaded(null);
    setState({ run: "loaded", lastError: "", statusLine: `resetting ${name}` });
    try {
      const result = await host.reset();
      if (operation !== operationRef.current) return;
      await host.setRenderer(rendererScale(configRef.current.Renderer));
      await host.setDynarec(configRef.current.Dynarec);
      if (operation !== operationRef.current) return;
      setLoaded(name);
      setState({
        run: "running", lastError: "",
        statusLine: result.source === "bios" ? `BIOS ${name} loaded`
          : `running ${name} (${(result.payloadBytes / 1024).toFixed(0)} KiB)`,
      });
      startLoop(name);
    } catch (error) {
      if (operation !== operationRef.current) return;
      presenter.clear();
      setLoaded(null);
      setState({ run: "error", lastError: `Reset failed: ${String(error)}`, statusLine: "reset failed" });
    }
  }, [audio, cancelLoop, host, loaded, presenter, releasePads, startLoop]);

  const stop = useCallback(() => {
    operationRef.current++;
    cancelLoop();
    releasePads();
    audio.pause();
    redrawRef.current = () => {};
    presenter.clear();
    setLoaded(null);
    setState({ run: "idle", lastError: "", statusLine: "ready" });
    void host.stop().catch((error) => setState({ lastError: `Stop failed: ${String(error)}` }));
  }, [audio, cancelLoop, host, presenter, releasePads]);

  const saveState = useCallback(async (slot: number) => {
    if (!loaded) return;
    stateSlotRef.current = slot;
    try {
      const bytes = await host.saveState();
      await storeSaveState(loaded, slot, new Uint8Array(bytes));
      setState({ lastError: "", statusLine: `saved state ${slot} · ${loaded}` });
    } catch (error) {
      setState({ lastError: `Save state ${slot} failed: ${String(error)}` });
    }
  }, [host, loaded]);

  const loadState = useCallback(async (slot: number) => {
    if (!loaded) return;
    const operation = ++operationRef.current;
    const name = loaded;
    stateSlotRef.current = slot;
    cancelLoop();
    releasePads();
    audio.pause();
    setState({ run: "loaded", lastError: "", statusLine: `loading state ${slot} · ${name}` });
    try {
      if (host.state === "running") await host.pause();
      const bytes = await loadStoredSaveState(name, slot);
      if (!bytes) throw new Error("No compatible state exists in this slot");
      if (operation !== operationRef.current) return;
      await host.loadState(exactBuffer(bytes));
      if (operation !== operationRef.current) return;
      audio.reset();
      void audio.resume();
      setState({ run: "running", lastError: "", statusLine: `loaded state ${slot} · ${name}` });
      startLoop(name);
    } catch (error) {
      if (operation === operationRef.current) {
        setState({ run: "paused", lastError: `Load state ${slot} failed: ${String(error)}` });
      }
    }
  }, [audio, cancelLoop, host, loaded, releasePads, startLoop]);

  workerErrorRef.current = (error) => {
    if (error.code !== "transport" && error.code !== "timeout") return;
    operationRef.current++;
    cancelLoop();
    audio.pause();
    presenter.clear();
    setLoaded(null);
    setState({ run: "error", lastError: `Worker: ${error.message}`, statusLine: "worker failed" });
  };

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
      else throw new Error("Fullscreen API unavailable");
      setState({ lastError: "" });
    } catch (error) {
      setState({ lastError: `Fullscreen request failed: ${String(error)}` });
    }
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    onFullscreen();
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F11" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void toggleFullscreen();
      } else if (event.key === "F1") {
        event.preventDefault();
        void saveState(stateSlotRef.current);
      } else if (event.key === "F3") {
        event.preventDefault();
        void loadState(stateSlotRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleFullscreen, saveState, loadState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.closest("input, select, textarea, [contenteditable=true], .menu-bar, .dialog-backdrop");
      if (dialog || editing || event.ctrlKey || event.metaKey || event.altKey) return;
      for (const [port, bindings, enabled] of [
        [1, config.Pad1Bindings, config.PadType1 !== 0],
        [2, config.Pad2Bindings, config.PadType2 !== 0],
      ] as const) {
        const button = PAD_BUTTONS.find((name) => bindings[name] !== "" && bindings[name] === event.code);
        if (!button || !enabled) continue;
        event.preventDefault();
        gamepadInput.setKeyboardButton(port, button, true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      for (const [port, bindings] of [[1, config.Pad1Bindings], [2, config.Pad2Bindings]] as const) {
        const button = PAD_BUTTONS.find((name) => bindings[name] !== "" && bindings[name] === event.code);
        if (!button) continue;
        gamepadInput.setKeyboardButton(port, button, false);
      }
    };
    const onBlur = () => {
      gamepadInput.setSuspended(true);
      releasePads();
    };
    const onFocus = () => gamepadInput.setSuspended(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      releasePads();
    };
  }, [config.Pad1Bindings, config.Pad2Bindings, config.PadType1, config.PadType2, dialog, gamepadInput, releasePads]);

  useEffect(() => {
    presenter.attach(canvasRef.current);
    return () => presenter.attach(null);
  }, [presenter]);

  useEffect(() => {
    const unbind = bindAudioUnlock(audio, window);
    return () => {
      unbind();
      audio.dispose();
      cancelLoop();
    };
  }, [audio, cancelLoop]);

  useEffect(() => () => {
    operationRef.current++;
    void host.dispose();
  }, [host]);

  useEffect(() => audio.setVolume(config.AudioVolume), [audio, config.AudioVolume]);
  useEffect(() => audio.setMuted(muted), [audio, muted]);
  useEffect(() => {
    if (!loaded) return;
    void host.setDynarec(config.Dynarec).catch((error) => {
      setState({ lastError: `Dynarec configuration failed: ${String(error)}` });
    });
  }, [config.Dynarec, host, loaded]);
  useEffect(() => {
    if (!loaded) return;
    const scale = rendererScale(config.Renderer);
    void host.setRenderer(scale).then(() => host.frame(scale)).catch((error) => {
      setState({ lastError: `Renderer configuration failed: ${String(error)}` });
    });
  }, [config.Renderer, host, loaded]);

  const onPick = useCallback((files: FileList | null, mode: FileMode) => {
    const file = files?.[0];
    if (!file) return;
    file.arrayBuffer().then((buf) => boot(buf, file.name, mode)).catch((error) => {
      cancelLoop();
      setState({ run: "error", lastError: `File read: ${String(error)}`, statusLine: "load failed" });
    });
  }, [boot, cancelLoop]);

  const openFile = (mode: FileMode) => {
    fileMode.current = mode;
    const input = fileInput.current;
    if (!input) return;
    input.accept = mode === "bios" ? ".bin,.rom" : mode === "exe" ? ".exe,.bin,.psexe,.psx" : ".exe,.bin,.psexe,.psx,.mdf";
    input.value = "";
    input.click();
  };

  const openDialog = (name: DialogName, padPort: 1 | 2 = 1) => {
    setGamepadPort(padPort);
    setDialog(name);
  };

  return (
    <div
      ref={rootRef}
      className={`epsxe-window${dragOver ? " is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        onPick(event.dataTransfer.files, "auto");
      }}
    >
      <header className="window-titlebar">ePSXe</header>
      <MainMenu
        run={run}
        hasMachine={loaded !== null}
        canStop={loaded !== null || run === "error"}
        fullscreen={fullscreen}
        fullscreenSupported={typeof document !== "undefined" && document.fullscreenEnabled}
        onOpenFile={openFile}
        onOpenDialog={openDialog}
        onPause={pause}
        onResume={resume}
        onReset={reset}
        onStop={stop}
        onSaveState={(slot) => void saveState(slot)}
        onLoadState={(slot) => void loadState(slot)}
        onToggleFullscreen={() => void toggleFullscreen()}
      />
      <DisplaySurface
        canvasRef={canvasRef}
        scaleMode={config.DisplayScale}
        bilinear={config.BilinearFilter}
        loaded={loaded !== null}
        onOpen={() => openFile("auto")}
        onResize={redraw}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".exe,.bin,.psexe,.psx,.mdf"
        className="file-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const mode = fileMode.current;
          onPick(event.currentTarget.files, mode);
          fileMode.current = "auto";
        }}
      />
      <footer className="status-bar" aria-live="polite">
        <span className={`status-message${lastError ? " has-error" : ""}`}>{lastError || statusLine}</span>
        <span className="status-file">{loaded ? `${loaded} · ${run}` : "No game loaded"}</span>
      </footer>
      {dialog === "video" && (
        <VideoConfigDialog
          onClose={() => setDialog(null)}
          fullscreen={fullscreen}
          onToggleFullscreen={() => void toggleFullscreen()}
        />
      )}
      {dialog === "sound" && (
        <Dialog title="Sound Configuration" onClose={() => setDialog(null)} showCancel={false} okLabel="Close">
          <fieldset className="dialog-frame">
            <legend className="dialog-frame-title">SPU Audio</legend>
            <div className="gpu-control-row">
              <label htmlFor="audio-volume">Main Volume</label>
              <input
                id="audio-volume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={config.AudioVolume}
                onChange={(event) => setConfig({ AudioVolume: Number(event.target.value) })}
              />
              <span>{Math.round(config.AudioVolume * 100)}%</span>
            </div>
            <label className="check-label">
              <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
              Mute
            </label>
            <button type="button" onClick={() => void audio.unlock()} disabled={audio.state === "running"}>
              {audio.state === "running" ? "Audio Unlocked" : "Unlock Audio"}
            </button>
            <p>Audio starts after a browser-approved click or key gesture. Status: {audio.state}.</p>
          </fieldset>
        </Dialog>
      )}
      {dialog === "gamepad" && <GamepadConfigDialog initialPort={gamepadPort} onClose={() => setDialog(null)} />}
      {dialog === "memcard" && <MemcardDialog host={loaded ? host : null} onClose={() => setDialog(null)} />}
      {dialog === "about" && (
        <Dialog title="About ePSXe Web" onClose={() => setDialog(null)} showCancel={false} okLabel="Close">
          <div className="about-content">
            <p>A client-side PlayStation emulator with Native, 2×, and 4× geometric rendering.</p>
            <p>Display scaling changes presentation only; internal resolution changes geometric sampling.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
