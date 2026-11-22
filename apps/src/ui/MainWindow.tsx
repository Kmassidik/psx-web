/**
 * window_main — React clone of the extracted ePSXe GTK blueprint
 * (knowledge-base/ui-blueprint/epsxe-gtk-interface-extracted.ui, id=window_main).
 * Menu labels are the blueprint's, verbatim.
 * Phase 1: File/Run PS-EXE path boots the machine and blits frames via rAF.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parsePsExe } from "../core/loader/psexe";
import { Machine } from "../core/machine";
import { useApp, setState } from "./store";
import { VideoConfigDialog } from "./dialogs/VideoConfigDialog";
import { GamepadConfigDialog } from "./dialogs/GamepadConfigDialog";
import { MemcardDialog } from "./dialogs/MemcardDialog";

export function MainWindow() {
  const run = useApp((s) => s.run);
  const statusLine = useApp((s) => s.statusLine);
  const lastError = useApp((s) => s.lastError);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"video" | "gamepad" | "memcard" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const machineRef = useRef<Machine | null>(null);
  const rafRef = useRef(0);

  const boot = useCallback((buf: ArrayBuffer, name: string) => {
    try {
      const bytes = new Uint8Array(buf);
      const exe = parsePsExe(bytes);
      const m = new Machine();
      m.loadExe(bytes, exe.pc0, exe.t_addr, exe.data);
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
          setState({ statusLine: `running ${name} · ${frames} fps` });
          frames = 0;
          lastFps = now;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setState({ run: "error", lastError: String(e), statusLine: "load failed" });
    }
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const onPick = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (!f) return;
      f.arrayBuffer().then((buf) => boot(buf, f.name));
    },
    [boot],
  );

  const menuStyle = "px-2 py-0.5 text-[13px] hover:bg-[#35507a] cursor-default select-none";

  return (
    <div
      className="flex h-screen flex-col bg-[#1b1d20] text-[#d6d3c8] font-[system-ui] text-[13px]"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files); }}
    >
      <div className="relative z-40 flex items-center gap-1 border-b border-[#2a2d31] bg-[#232629] px-1 py-1">
        <span className={menuStyle}>File</span>
        <span className={menuStyle}>Run</span>
        <span className={menuStyle}>Config</span>
        <span
          className={menuStyle}
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenu(openMenu === "Options" ? null : "Options");
          }}
        >
          Options
        </span>
        {openMenu === "Options" && (
          <div
            className="absolute left-[104px] top-full flex flex-col border border-[#2a2d31] bg-[#232629] py-1 shadow-lg"
            onClick={() => setOpenMenu(null)}
          >
            <span className={menuStyle} onClick={() => setDialog("video")}>
              Video
            </span>
            <span className={menuStyle} onClick={() => setDialog("gamepad")}>
              Game Pads
            </span>
            <span className={menuStyle} onClick={() => setDialog("memcard")}>
              Memory card
            </span>
          </div>
        )}
        <span className="ml-auto text-[11px] text-[#8a8880]">psx-web · from scratch</span>
      </div>
      {dialog === "video" && <VideoConfigDialog onClose={() => setDialog(null)} />}
      {dialog === "gamepad" && <GamepadConfigDialog onClose={() => setDialog(null)} />}
      {dialog === "memcard" && <MemcardDialog onClose={() => setDialog(null)} />}

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

      <div className="flex items-center justify-between border-t border-[#2a2d31] bg-[#232629] px-3 py-1">
        <span className={lastError ? "text-[#e06c60]" : "text-[#9aa87c]"}>{lastError || statusLine}</span>
        <span className="text-[11px] text-[#8a8880]">
          {loaded ? `${loaded} · ${run}` : "drop a PS-X EXE to boot (no BIOS needed)"}
        </span>
      </div>
    </div>
  );
}

