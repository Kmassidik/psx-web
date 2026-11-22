/**
 * window_main — React clone of the extracted ePSXe GTK blueprint
 * (knowledge-base/ui-blueprint/epsxe-gtk-interface-extracted.ui, id=window_main).
 * Menu labels are the blueprint's, verbatim. Phase 0 scope: File/Run PS-EXE path.
 */
import { useCallback, useRef, useState } from "react";
import { parsePsExe, loadIntoRam, type PsExe } from "../core/loader/psexe";
import { Memory } from "../core/memory";
import { useApp, setState } from "./store";

interface LoadedExe {
  exe: PsExe;
  mem: Memory;
  name: string;
}

export function MainWindow() {
  const run = useApp((s) => s.run);
  const statusLine = useApp((s) => s.statusLine);
  const lastError = useApp((s) => s.lastError);
  const [loaded, setLoaded] = useState<LoadedExe | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadExe = useCallback((buf: ArrayBuffer, name: string) => {
    try {
      const bytes = new Uint8Array(buf);
      const exe = parsePsExe(bytes);
      const mem = new Memory();
      loadIntoRam(mem, exe);
      setLoaded({ exe, mem, name });
      setState({
        run: "loaded",
        lastError: "",
        statusLine: `loaded ${name} pc=0x${exe.pc0.toString(16)} t_addr=0x${exe.t_addr.toString(16)} (${(exe.t_size / 1024).toFixed(0)} KiB)`,
      });
    } catch (e) {
      setState({ run: "error", lastError: String(e), statusLine: "load failed" });
    }
  }, []);

  const onPick = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (!f) return;
      f.arrayBuffer().then((buf) => loadExe(buf, f.name));
    },
    [loadExe],
  );

  const menuStyle = "px-2 py-0.5 text-[13px] hover:bg-[#35507a] cursor-default select-none";

  return (
    <div
      className="flex h-screen flex-col bg-[#1b1d20] text-[#d6d3c8] font-[system-ui] text-[13px]"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files); }}
    >
      {/* menubar1 — blueprint order: File / Run / Config / Options / Help(about action) */}
      <div className="flex items-center gap-1 border-b border-[#2a2d31] bg-[#232629] px-1 py-1">
        <span className={menuStyle}>File</span>
        <span className={menuStyle}>Run</span>
        <span className={menuStyle}>Config</span>
        <span className={menuStyle}>Options</span>
        <span className="ml-auto text-[11px] text-[#8a8880]">psx-web · from scratch</span>
      </div>

      {/* Run CD-ROM / Run ISO / Run PS-EXE surface — Phase 0 = PS-EXE only */}
      <div
        className={`flex flex-1 items-center justify-center ${dragOver ? "bg-[#232d3a]" : ""}`}
        onClick={() => fileInput.current?.click()}
      >
        <canvas
          ref={canvasRef}
          width={640}
          height={480}
          className="border border-[#2a2d31] bg-black"
          style={{ imageRendering: "pixelated", maxWidth: "90vw", maxHeight: "70vh" }}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".exe,.bin,.psexe,.psx"
          className="hidden"
          onChange={(e) => onPick(e.target.files)}
        />
      </div>

      {/* status bar — mirrors fpsDisplayFull line */}
      <div className="flex items-center justify-between border-t border-[#2a2d31] bg-[#232629] px-3 py-1">
        <span className={lastError ? "text-[#e06c60]" : "text-[#9aa87c]"}>{lastError || statusLine}</span>
        <span className="text-[11px] text-[#8a8880]">
          {loaded ? `${loaded.name} · ${run}` : "drop a PS-X EXE to load (no BIOS needed)"}
        </span>
      </div>
    </div>
  );
}
