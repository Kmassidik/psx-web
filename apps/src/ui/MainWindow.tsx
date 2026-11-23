/**
 * window_main — React clone of the extracted ePSXe GTK blueprint
 * (knowledge-base/ui-blueprint/epsxe-gtk-interface-extracted.ui, id=window_main).
 * Menu labels are the blueprint's, verbatim.
 * Phase 1: File/Run PS-EXE path boots the machine and blits frames via rAF.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { parsePsExe } from "../core/loader/psexe";
import { createMdfSectorProvider } from "../core/loader/mdf";
import { readIsoFile } from "../core/loader/iso9660";
import { Machine } from "../core/machine";
import { setConfig, setState, useApp } from "./store";
import { VideoConfigDialog } from "./dialogs/VideoConfigDialog";
import { GamepadConfigDialog } from "./dialogs/GamepadConfigDialog";
import { MemcardDialog } from "./dialogs/MemcardDialog";

type FileMode = "auto" | "exe" | "bios";
type DialogName = "video" | "gamepad" | "memcard";

const PAD_BITS: Record<string, number> = {
  x: 0x0040, // Cross
  Enter: 0x0800, // Start
  ArrowUp: 0x1000,
  ArrowRight: 0x2000,
  ArrowDown: 0x4000,
  ArrowLeft: 0x8000,
};

interface MenuItemProps {
  label: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}

function MenuItem({ label, action, checked, disabled, children }: MenuItemProps) {
  const submenu = children !== undefined;
  return (
    <li className={submenu ? "menu-has-submenu" : ""} role="none">
      <button
        type="button"
        className="menu-item"
        role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked}
        aria-haspopup={submenu || undefined}
        data-command={action ? "" : undefined}
        disabled={disabled}
        onClick={action}
      >
        <span className="menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
        <span className="menu-label">{label}</span>
        {submenu && <span className="submenu-arrow" aria-hidden="true">▶</span>}
      </button>
      {submenu && <ul className="menu-popup submenu" role="menu">{children}</ul>}
    </li>
  );
}

function MenuSeparator() {
  return <li className="menu-separator" role="separator"><hr /></li>;
}

const stateSlots = [1, 2, 3, 4, 5];
const overclockRates = [1, 1.5, 2, 3, 4];

export function MainWindow() {
  const run = useApp((s) => s.run);
  const statusLine = useApp((s) => s.statusLine);
  const lastError = useApp((s) => s.lastError);
  const config = useApp((s) => s.config);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMode = useRef<FileMode>("auto");
  const machineRef = useRef<Machine | null>(null);
  const rafRef = useRef(0);

  const boot = useCallback((buf: ArrayBuffer, name: string, mode: FileMode) => {
    try {
      const bytes = new Uint8Array(buf);
      // BIOS dump (512 KiB) vs PS-EXE: size discriminator (load_bios spec).
      if (bytes.byteLength === 512 * 1024 && (mode === "bios" || name.toLowerCase().includes("bios"))) {
        const m = machineRef.current ?? new Machine();
        m.loadBios(bytes);
        machineRef.current = m;
        setLoaded(name);
        setState({ run: "running", lastError: "", statusLine: `BIOS ${name} loaded — drop a PS-X EXE or CUE/BIN next` });
        return;
      }
      let exeBytes = bytes;
      let bootStage = "PS-X EXE";
      const m = new Machine();
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
      setLoaded(name);
      setState({
        run: "running",
        lastError: "",
        statusLine: `running ${name} pc=0x${exe.pc0.toString(16)} (${(exe.t_size / 1024).toFixed(0)} KiB)`,
      });

      // rAF loop: fixed instruction slice per frame; pixels bypass React.
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d") ?? null;
      const img = ctx ? ctx.createImageData(640, 480) : null;
      let frames = 0;
      let lastFps = performance.now();
      const tick = () => {
        const machine = machineRef.current;
        if (!machine) return;
        machine.runSlice(20_000); // ~0.33 ms of emulated CPU per rAF (placeholder clock)
        machine.gpu.composeFrame();
        if (img && ctx) {
          img.data.set(machine.gpu.screen);
          ctx.putImageData(img, 0, 0);
        }
        frames++;
        const now = performance.now();
        if (now - lastFps >= 1000) {
          setState({ statusLine: `running ${name} · ${frames} fps · pc=0x${(machine.cpu.pc >>> 0).toString(16)}` });
          frames = 0;
          lastFps = now;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setState({ run: "error", lastError: `${bootStage}: ${String(e)}`, statusLine: "load failed" });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
      const bit = PAD_BITS[event.key];
      if (bit && machineRef.current) {
        event.preventDefault();
        machineRef.current.pads.pad1 &= ~bit;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const bit = PAD_BITS[event.key];
      if (bit && machineRef.current) machineRef.current.pads.pad1 |= bit;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onPick = useCallback(
    (files: FileList | null, mode: FileMode) => {
      const file = files?.[0];
      if (!file) return;
      file.arrayBuffer().then((buf) => boot(buf, file.name, mode));
    },
    [boot],
  );

  const openFile = (mode: FileMode) => {
    fileMode.current = mode;
    const input = fileInput.current;
    if (!input) return;
    input.accept = mode === "bios" ? ".bin,.rom" : mode === "exe" ? ".exe,.psexe,.psx" : ".exe,.bin,.psexe,.psx";
    input.value = "";
    input.click();
  };

  const openDialog = (name: DialogName) => {
    setOpenMenu(null);
    setDialog(name);
  };

  return (
    <div
      className={`epsxe-window${dragOver ? " is-dragging" : ""}`}
      onClick={() => setOpenMenu(null)}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        onPick(event.dataTransfer.files, "auto");
      }}
    >
      <header className="window-titlebar">ePSXe</header>
      <nav
        className="menu-bar"
        aria-label="ePSXe main menu"
        onClick={(event) => {
          event.stopPropagation();
          if ((event.target as HTMLElement).closest("[data-command]")) setOpenMenu(null);
        }}
      >
        <div className="top-menu">
          <button
            type="button"
            className={`menu-top${openMenu === "File" ? " is-open" : ""}`}
            aria-expanded={openMenu === "File"}
            aria-haspopup="true"
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(openMenu === "File" ? null : "File");
            }}
            onMouseEnter={() => { if (openMenu) setOpenMenu("File"); }}
          >File</button>
          {openMenu === "File" && (
            <ul className="menu-popup" role="menu">
              <MenuItem label="Run CD-ROM" disabled />
              <MenuItem label="Run ISO" disabled />
              <MenuItem label="Run PS-EXE" action={() => openFile("exe")} />
              <MenuItem label="Run BIOS" action={() => openFile("bios")} />
              <MenuSeparator />
              <MenuItem label="Open Gamelist" disabled />
              <MenuSeparator />
              <MenuItem label="Local Netplay">
                <MenuItem label="Player 1" disabled />
                <MenuItem label="Player 2" disabled />
              </MenuItem>
              <MenuSeparator />
              <MenuItem label="Change Disc">
                <MenuItem label="CD-ROM" disabled />
                <MenuItem label="ISO" disabled />
              </MenuItem>
              <MenuSeparator />
              <MenuItem label="Exit" disabled />
            </ul>
          )}
        </div>

        <div className="top-menu">
          <button
            type="button"
            className={`menu-top${openMenu === "Run" ? " is-open" : ""}`}
            aria-expanded={openMenu === "Run"}
            aria-haspopup="true"
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(openMenu === "Run" ? null : "Run");
            }}
            onMouseEnter={() => { if (openMenu) setOpenMenu("Run"); }}
          >Run</button>
          {openMenu === "Run" && (
            <ul className="menu-popup" role="menu">
              <MenuItem label="Continue" disabled />
              <MenuSeparator />
              <MenuItem label="Reset" disabled />
              <MenuSeparator />
              <MenuItem label="Save State (F1)">
                {stateSlots.map((slot) => <MenuItem key={slot} label={`Slot ${slot}`} disabled />)}
              </MenuItem>
              <MenuItem label="Load State (F3)">
                {stateSlots.map((slot) => <MenuItem key={slot} label={`Slot ${slot}`} disabled />)}
              </MenuItem>
            </ul>
          )}
        </div>

        <div className="top-menu">
          <button
            type="button"
            className={`menu-top${openMenu === "Config" ? " is-open" : ""}`}
            aria-expanded={openMenu === "Config"}
            aria-haspopup="true"
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(openMenu === "Config" ? null : "Config");
            }}
            onMouseEnter={() => { if (openMenu) setOpenMenu("Config"); }}
          >Config</button>
          {openMenu === "Config" && (
            <ul className="menu-popup" role="menu">
              <MenuItem label="Plugins">
                <MenuItem label="Video" disabled />
                <MenuItem label="Sound" disabled />
                <MenuItem label="Input Port 1" disabled />
                <MenuItem label="Input Port 2" disabled />
              </MenuItem>
              <MenuItem label="Video" action={() => openDialog("video")} />
              <MenuItem label="Sound" disabled />
              <MenuItem label="Cd-rom" disabled />
              <MenuItem label="Game Pads">
                <MenuItem label="Port 1">
                  <MenuItem label="Pad 1" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 2" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 3" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 4" action={() => openDialog("gamepad")} />
                  <MenuItem label="Multitap" disabled />
                  <MenuItem label="Autofire Pad 1" disabled />
                </MenuItem>
                <MenuItem label="Port 2">
                  <MenuItem label="Pad 1" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 2" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 3" action={() => openDialog("gamepad")} />
                  <MenuItem label="Pad 4" action={() => openDialog("gamepad")} />
                  <MenuItem label="Multitap" disabled />
                  <MenuItem label="Autofire Pad 2" disabled />
                </MenuItem>
              </MenuItem>
              <MenuSeparator />
              <MenuItem label="Bios" disabled />
              <MenuSeparator />
              <MenuItem label="Memory card" action={() => openDialog("memcard")} />
            </ul>
          )}
        </div>

        <div className="top-menu">
          <button
            type="button"
            className={`menu-top${openMenu === "Options" ? " is-open" : ""}`}
            aria-expanded={openMenu === "Options"}
            aria-haspopup="true"
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(openMenu === "Options" ? null : "Options");
            }}
            onMouseEnter={() => { if (openMenu) setOpenMenu("Options"); }}
          >Options</button>
          {openMenu === "Options" && (
            <ul className="menu-popup" role="menu">
              <MenuItem label="CPU Overclocking">
                {overclockRates.map((rate) => (
                  <MenuItem
                    key={rate}
                    label={`x${rate}`}
                    checked={config.CpuOverclocking === rate}
                    action={() => setConfig({ CpuOverclocking: rate })}
                  />
                ))}
              </MenuItem>
              <MenuItem label="CPU Mode">
                <MenuItem
                  label="Dynarec (fast)"
                  checked={config.Dynarec}
                  action={() => setConfig({ Dynarec: true })}
                />
                <MenuItem
                  label="Interpreter (Accurate)"
                  checked={!config.Dynarec}
                  action={() => setConfig({ Dynarec: false })}
                />
              </MenuItem>
              <MenuItem label="GTE hacks">
                <MenuItem
                  label="Widescreen"
                  checked={config.Widescreen}
                  action={() => setConfig({ Widescreen: !config.Widescreen })}
                />
                <MenuItem label="Subpixel precision" disabled />
              </MenuItem>
              <MenuItem label="Auto load ppf files" disabled />
              <MenuItem label="Cheat codes" disabled />
              <MenuItem label="Game Profiles">
                <MenuItem label="Save Profile" disabled />
                <MenuItem label="Delete Profile" disabled />
              </MenuItem>
            </ul>
          )}
        </div>

        <div className="top-menu help-menu">
          <button
            type="button"
            className={`menu-top${openMenu === "Help" ? " is-open" : ""}`}
            aria-expanded={openMenu === "Help"}
            aria-haspopup="true"
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(openMenu === "Help" ? null : "Help");
            }}
            onMouseEnter={() => { if (openMenu) setOpenMenu("Help"); }}
          >Help</button>
          {openMenu === "Help" && (
            <ul className="menu-popup" role="menu">
              <MenuItem label="Visit ePSXe website" action={() => window.open("https://www.epsxe.com", "_blank", "noopener,noreferrer")} />
              <MenuSeparator />
              <MenuItem label="About" disabled />
            </ul>
          )}
        </div>
      </nav>

      <main
        className="display-area"
        onClick={() => openFile("auto")}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openFile("auto");
        }}
        role="button"
        tabIndex={0}
        aria-label="Open a PS-X EXE"
      >
        <div className="canvas-shell">
          <canvas ref={canvasRef} width={640} height={480} className="game-canvas" />
          {!loaded && (
            <div className="display-hint" aria-hidden="true">
              <span className="epsxe-wordmark">ePSXe</span>
              <span>Drop a PS-X EXE here or choose File → Run PS-EXE</span>
            </div>
          )}
        </div>
      </main>
      <input
        ref={fileInput}
        type="file"
        accept=".exe,.bin,.psexe,.psx,.mdf"
        className="file-input"
        onChange={(event) => {
          const mode = fileMode.current;
          onPick(event.currentTarget.files, mode);
          fileMode.current = "auto";
        }}
      />

      <footer className="status-bar">
        <span className={`status-message${lastError ? " has-error" : ""}`}>{lastError || statusLine}</span>
        <span className="status-file">{loaded ? `${loaded} · ${run}` : "No game loaded"}</span>
      </footer>

      {dialog === "video" && <VideoConfigDialog onClose={() => setDialog(null)} />}
      {dialog === "gamepad" && <GamepadConfigDialog onClose={() => setDialog(null)} />}
      {dialog === "memcard" && <MemcardDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

