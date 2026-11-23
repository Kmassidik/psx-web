/** Native-resolution, client-side PS1 window and emulator lifecycle. */
import { useCallback, useEffect, useRef, useState } from "react";
import { parsePsExe } from "../core/loader/psexe";
import { createMdfSectorProvider } from "../core/loader/mdf";
import { readIsoFile } from "../core/loader/iso9660";
import { Machine } from "../core/machine";
import { SpuAudioSink } from "../core/spu-audio";
import { bindAudioUnlock } from "./audio";
import { loadStoredSaveState, storeSaveState } from "./save-state-storage";
import { GamepadInput } from "./gamepad-input";
import { attachStoredMemoryCards } from "./memory-card-storage";
import { PAD_BUTTONS, type PsxConfig } from "../state/config";
import { getState, setConfig, setState, useApp } from "./store";
import { DisplaySurface } from "./DisplaySurface";
import { MainMenu, type DialogName, type FileMode } from "./MainMenu";
import { VideoConfigDialog } from "./dialogs/VideoConfigDialog";
import { GamepadConfigDialog } from "./dialogs/GamepadConfigDialog";
import { MemcardDialog } from "./dialogs/MemcardDialog";
import { Dialog } from "./dialogs/Dialog";

interface BootSource {
  buffer: ArrayBuffer;
  name: string;
  mode: FileMode;
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
  const machineRef = useRef<Machine | null>(null);
  const gamepadInputRef = useRef<GamepadInput | null>(null);
  if (!gamepadInputRef.current) gamepadInputRef.current = new GamepadInput();
  const gamepadInput = gamepadInputRef.current;
  const bootSourceRef = useRef<BootSource | null>(null);
  const configRef = useRef<PsxConfig>(config);
  const rafRef = useRef(0);
  const audioRef = useRef<SpuAudioSink | null>(null);
  if (!audioRef.current) audioRef.current = new SpuAudioSink({ volume: config.AudioVolume });
  const audio = audioRef.current;
  const [muted, setMuted] = useState(false);
  const redrawRef = useRef<() => void>(() => {});
  configRef.current = config;

  const releasePads = useCallback(() => {
    gamepadInput.release(machineRef.current);
  }, [gamepadInput]);

  const cancelLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const redraw = useCallback(() => redrawRef.current(), []);

  const startLoop = useCallback((name: string) => {
    cancelLoop();
    const machine = machineRef.current;
    const canvas = canvasRef.current;
    if (!machine || !canvas) return;
    const nativeCanvas = document.createElement("canvas");
    const nativeContext = nativeCanvas.getContext("2d");
    const context = canvas.getContext("2d");
    let image: ImageData | null = null;
    let frames = 0;
    let lastFps = performance.now();
    let lastCycleTime = lastFps;
    let cycleBudget = 0;

    const present = () => {
      if (machineRef.current !== machine || !nativeContext || !context) return;
      const frame = machine.gpu.composeDisplayFrame();
      if (nativeCanvas.width !== frame.width || nativeCanvas.height !== frame.height) {
        nativeCanvas.width = frame.width;
        nativeCanvas.height = frame.height;
        image = nativeContext.createImageData(frame.width, frame.height);
      }
      image ??= nativeContext.createImageData(frame.width, frame.height);
      image.data.set(frame.rgba);
      nativeContext.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = configRef.current.BilinearFilter;
      context.drawImage(nativeCanvas, 0, 0, canvas.width, canvas.height);
    };
    redrawRef.current = present;

    const tick = () => {
      if (machineRef.current !== machine || getState().run !== "running") return;
      gamepadInput.poll(machine, configRef.current);
      const cycleNow = performance.now();
      const elapsed = Math.min(100, Math.max(0, cycleNow - lastCycleTime));
      lastCycleTime = cycleNow;
      cycleBudget = Math.min(cycleBudget + elapsed * 33_868.8, 3_386_880);
      while (cycleBudget >= 20_000) {
        machine.runSlice(20_000);
        cycleBudget -= 20_000;
      }
      present();
      frames++;
      const now = performance.now();
      if (now - lastFps >= 1000) {
        const fps = configRef.current.ShowFPS ? ` · ${frames} fps` : "";
        setState({ statusLine: `running ${name}${fps}` });
        frames = 0;
        lastFps = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    present();
    rafRef.current = requestAnimationFrame(tick);
  }, [cancelLoop, gamepadInput]);

  const boot = useCallback((buf: ArrayBuffer, name: string, mode: FileMode) => {
    let bootStage = "PS-X EXE";
    cancelLoop();
    releasePads();
    audio.reset();
    void audio.resume();
    try {
      const bytes = new Uint8Array(buf);
      // BIOS dump (512 KiB) vs PS-EXE: size discriminator (load_bios spec).
      if (bytes.byteLength === 512 * 1024 && (mode === "bios" || name.toLowerCase().includes("bios"))) {
        const m = new Machine();
        attachStoredMemoryCards(m, [configRef.current.Memcard1, configRef.current.Memcard2]);
        gamepadInput.attach(m);
        m.setAudioSink(audio);
        m.loadBios(bytes);
        machineRef.current = m;
        bootSourceRef.current = { buffer: buf, name, mode };
        setLoaded(name);
        setState({ run: "running", lastError: "", statusLine: `BIOS ${name} loaded` });
        startLoop(name);
        return;
      }
      let exeBytes = bytes;
      bootStage = "PS-X EXE";
      const m = new Machine();
      attachStoredMemoryCards(m, [configRef.current.Memcard1, configRef.current.Memcard2]);
      gamepadInput.attach(m);
      m.setAudioSink(audio);
      if (name.toLowerCase().endsWith(".mdf")) {
        const provider = createMdfSectorProvider(bytes);
        m.setSectorProvider(provider);
        bootStage = "front-end parse";
        const frontendBytes = readIsoFile(provider, "cdrom:\\FE.EXE;1");
        if (!frontendBytes) throw new Error("No front-end executable found in MDF");
        const frontendExe = parsePsExe(frontendBytes);
        m.loadExe(frontendBytes, frontendExe.pc0, frontendExe.t_addr, frontendExe.data);
        bootStage = "front-end run";
        for (let i = 0; i < 300; i++) m.runSlice(20_000);
        bootStage = "game parse";
        const gameBytes = readIsoFile(provider, "cdrom:\\GAME.EXE;1");
        if (!gameBytes) throw new Error("No game executable found in MDF");
        exeBytes = gameBytes;
      }
      const exe = parsePsExe(exeBytes);
      m.loadExe(exeBytes, exe.pc0, exe.t_addr, exe.data);
      machineRef.current = m;
      bootSourceRef.current = { buffer: buf, name, mode };
      setLoaded(name);
      setState({
        run: "running",
        lastError: "",
        statusLine: `running ${name} (${(exe.t_size / 1024).toFixed(0)} KiB)`,
      });
      startLoop(name);
    } catch (e) {
      machineRef.current = null;
      bootSourceRef.current = null;
      redrawRef.current = () => {};
      setLoaded(null);
      setState({ run: "error", lastError: `${bootStage}: ${String(e)}`, statusLine: "load failed" });
    }
  }, [cancelLoop, gamepadInput, releasePads, startLoop]);

  const pause = useCallback(() => {
    if (getState().run !== "running" || !loaded) return;
    cancelLoop();
    releasePads();
    audio.pause();
    setState({ run: "paused", statusLine: `paused ${loaded}` });
  }, [cancelLoop, loaded, releasePads]);

  const resume = useCallback(() => {
    if (getState().run !== "paused" || !loaded || !machineRef.current) return;
    void audio.resume();
    setState({ run: "running", lastError: "", statusLine: `running ${loaded}` });
    startLoop(loaded);
  }, [loaded, startLoop]);

  const reset = useCallback(() => {
    const source = bootSourceRef.current;
    if (source) boot(source.buffer, source.name, source.mode);
  }, [boot]);

  const stop = useCallback(() => {
    cancelLoop();
    releasePads();
    audio.pause();
    machineRef.current = null;
    bootSourceRef.current = null;
    redrawRef.current = () => {};
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setLoaded(null);
    setState({ run: "idle", lastError: "", statusLine: "ready" });
  }, [cancelLoop, releasePads]);

  const saveState = useCallback(async (slot: number) => {
    const machine = machineRef.current;
    if (!machine || !loaded) return;
    stateSlotRef.current = slot;
    try {
      const bytes = machine.saveState();
      await storeSaveState(loaded, slot, bytes);
      setState({ lastError: "", statusLine: `saved state ${slot} · ${loaded}` });
    } catch (error) {
      setState({ lastError: `Save state ${slot} failed: ${String(error)}` });
    }
  }, [loaded]);

  const loadState = useCallback(async (slot: number) => {
    const machine = machineRef.current;
    if (!machine || !loaded) return;
    stateSlotRef.current = slot;
    cancelLoop();
    try {
      const bytes = await loadStoredSaveState(loaded, slot);
      if (!bytes) throw new Error("No compatible state exists in this slot");
      machine.loadState(bytes);
      audio.reset();
      setState({ run: "running", lastError: "", statusLine: `loaded state ${slot} · ${loaded}` });
      startLoop(loaded);
    } catch (error) {
      setState({ run: "paused", lastError: `Load state ${slot} failed: ${String(error)}` });
    }
  }, [audio, cancelLoop, loaded, startLoop]);

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
    const unbind = bindAudioUnlock(audio, window);
    return () => {
      unbind();
      machineRef.current?.setAudioSink(null);
      audio.dispose();
      cancelLoop();
    };
  }, [audio, cancelLoop]);

  useEffect(() => audio.setVolume(config.AudioVolume), [audio, config.AudioVolume]);
  useEffect(() => audio.setMuted(muted), [audio, muted]);

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
      {dialog === "memcard" && <MemcardDialog machine={machineRef.current} onClose={() => setDialog(null)} />}
      {dialog === "about" && (
        <Dialog title="About ePSXe Web" onClose={() => setDialog(null)} showCancel={false} okLabel="Close">
          <div className="about-content">
            <p>A client-side PlayStation emulator with a native-resolution renderer.</p>
            <p>Display scaling changes presentation only, not emulated detail.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
