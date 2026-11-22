/**
 * VideoConfigDialog — clone of the blueprint's window_config_videocore
 * ("Config GPUCore"): frames Resolutions and Colors / Framerate /
 * Fullscreen Filters, all keyed to PsxConfig fields.
 */
import { useState } from "react";
import { type PsxConfig } from "../../state/config";
import { useApp, setConfig } from "../store";
import { Dialog, buttonClass, entryClass, frameClass, frameTitleClass, labelClass, selectClass } from "./Dialog";

const GPUDISPMODE_LABELS = ["Fullscreen Mode", "Window Mode"] as const;
const GPUIRES_OPTIONS = ["1: Normal Resolution", "2: Resolution x2", "4: Resolution x4"] as const;
const GPURATIO_OPTIONS = ["0: Stretch", "1: 4:3", "2: Widescreen"] as const;
const GPUBPROFILE_OPTIONS = ["0: Original", "1: Brightness", "2: More brightness", "3: Most brightness"] as const;
const GPUBLITMODE_OPTIONS = ["1: OpenGLv1", "2: OpenGLv2"] as const;
const GPUFULLRES_OPTIONS = ["640x480", "800x600", "1024x768", "1280x960", "1600x1200"] as const;
const GPURUNMODE_OPTIONS = ["0: 1-Thread", "1: 2-Threads"] as const;
const GPU2DFILTER_OPTIONS = [
  "0: None",
  "1: 2xSai",
  "2: xBRZ x2",
  "3: xBRZ x3",
  "4: xBRZ x4",
] as const;
const GPUSHADER_OPTIONS = [
  "0: None",
  "1: FXAA",
  "2: CRT-Hyllian",
  "3: CRT-Lottes",
  "4: xBR-LV2-3D",
  "99: Custom",
] as const;

export interface VideoConfigDialogProps {
  onClose: () => void;
}

/** Clone of window_config_videocore. Local draft state; OK commits via setConfig. */
export function VideoConfigDialog({ onClose }: VideoConfigDialogProps) {
  const live = useApp((s) => s.config);
  const [cfg, setCfg] = useState<PsxConfig>(live);
  const patch = (p: Partial<PsxConfig>) => setCfg({ ...cfg, ...p });

  return (
    <Dialog
      title="Config GPUCore"
      onClose={onClose}
      onOk={() => setConfig(cfg)}
    >
      <div className="flex flex-col gap-3">
        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Resolutions and Colors</legend>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-6">
              <span className={labelClass}>Display Mode</span>
              {GPUDISPMODE_LABELS.map((label, i) => (
                <label key={label} className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="radio"
                    name="gpudispmode"
                    checked={cfg.Scanlines === (i === 0)}
                    onChange={() => patch({ Scanlines: i === 0 })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Window Size</span>
              <input
                className={`${entryClass} w-16`}
                value={String(cfg.ResolutionX)}
                onChange={(e) => patch({ ResolutionX: Number(e.target.value) || 0 })}
              />
              <span className={labelClass}>x</span>
              <input
                className={`${entryClass} w-16`}
                value={String(cfg.ResolutionY)}
                onChange={(e) => patch({ ResolutionY: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>FullScreen Size</span>
              <select
                className={selectClass}
                value={`${cfg.ResolutionX}x${cfg.ResolutionY}`}
                onChange={(e) => {
                  const [x, y] = e.target.value.split("x").map(Number);
                  patch({ ResolutionX: x ?? cfg.ResolutionX, ResolutionY: y ?? cfg.ResolutionY });
                }}
              >
                {GPUFULLRES_OPTIONS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Internal Resolution</span>
              <select
                className={selectClass}
                value={cfg.CpuOverclocking === 1 ? 0 : cfg.CpuOverclocking === 2 ? 1 : 2}
                onChange={(e) =>
                  patch({ CpuOverclocking: [1, 2, 4][Number(e.target.value)] ?? 1 })
                }
              >
                {GPUIRES_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Brightness Profile</span>
              <select
                className={selectClass}
                value={cfg.SpuQuality - 1}
                onChange={(e) => patch({ SpuQuality: Number(e.target.value) + 1 })}
              >
                {GPUBPROFILE_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Screen Ratio</span>
              <select
                className={selectClass}
                value={cfg.Widescreen ? 2 : 1}
                onChange={(e) => patch({ Widescreen: Number(e.target.value) === 2 })}
              >
                {GPURATIO_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Blit Mode</span>
              <select
                className={selectClass}
                value={cfg.BiosHLE ? 0 : 1}
                onChange={(e) => patch({ BiosHLE: Number(e.target.value) === 0 })}
              >
                {GPUBLITMODE_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px] text-right`}>Threading Mode</span>
              <select
                className={selectClass}
                value={cfg.Dynarec ? 1 : 0}
                onChange={(e) => patch({ Dynarec: Number(e.target.value) === 1 })}
              >
                {GPURUNMODE_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Framerate</legend>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={cfg.ShowFPS}
                onChange={(e) => patch({ ShowFPS: e.target.checked })}
              />
              Show FPS
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={cfg.FrameLimit}
                onChange={(e) => patch({ FrameLimit: e.target.checked })}
              />
              Enable FPS Limit
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={cfg.FrameSkip > 0}
                onChange={(e) => patch({ FrameSkip: e.target.checked ? 1 : 0 })}
              />
              Enable Frameskip
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <span className={labelClass}>Custom FPS (0=disabled)</span>
              <input
                className={`${entryClass} w-16`}
                value={String(cfg.FrameSkip)}
                onChange={(e) => patch({ FrameSkip: Number(e.target.value) || 0 })}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Fullscreen Filters</legend>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={cfg.Vsync}
                onChange={(e) => patch({ Vsync: e.target.checked })}
              />
              Screen filtering
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <input
                type="checkbox"
                checked={cfg.EnableGUI}
                onChange={(e) => patch({ EnableGUI: e.target.checked })}
              />
              Fullscreen bilinear filter
            </label>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px]`}>Filter for 2D games</span>
              <select
                className={selectClass}
                value={cfg.Filter2D}
                onChange={(e) => patch({ Filter2D: Number(e.target.value) })}
              >
                {GPU2DFILTER_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className={`${labelClass} w-[150px]`}>Shader Effects</span>
              <select
                className={selectClass}
                value={cfg.Shader === "" ? "0: None" : cfg.Shader}
                onChange={(e) => patch({ Shader: e.target.value === "0: None" ? "" : e.target.value })}
              >
                {GPUSHADER_OPTIONS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <button className={buttonClass} title="Select shader directory">
                ...
              </button>
            </div>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
