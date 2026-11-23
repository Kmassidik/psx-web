/** Native renderer presentation preferences; unsupported GPU features are explicit. */
import { useState } from "react";
import { DEFAULT_CONFIG, type DisplayScale } from "../../state/config";
import { useApp, setConfig } from "../store";
import { Dialog, buttonClass, entryClass, frameClass, frameTitleClass, labelClass, selectClass } from "./Dialog";

const unsupported = (feature: string) => `${feature} is not implemented by the native renderer.`;

export interface VideoConfigDialogProps {
  onClose: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

export function VideoConfigDialog({ onClose, fullscreen, onToggleFullscreen }: VideoConfigDialogProps) {
  const live = useApp((s) => s.config);
  const [scale, setScale] = useState<DisplayScale>(live.DisplayScale);
  const [showFps, setShowFps] = useState(live.ShowFPS);
  const [bilinear, setBilinear] = useState(live.BilinearFilter);

  return (
    <Dialog
      title="Config GPUCore"
      onClose={onClose}
      onOk={() => setConfig({ DisplayScale: scale, ShowFPS: showFps, BilinearFilter: bilinear })}
    >
      <div className="dialog-stack">
        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Resolutions and Colors</legend>
          <div className="gpu-fields">
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="display-scale">Display Scaling</label>
              <select id="display-scale" className={selectClass} value={scale} onChange={(e) => setScale(e.target.value as DisplayScale)}>
                <option value="fit">Fit (preserve aspect ratio)</option>
                <option value="integer">Integer (native pixels)</option>
                <option value="stretch">Stretch (fill window)</option>
              </select>
            </div>
            <div className="gpu-control-row">
              <span className={`${labelClass} field-label`}>Display Mode</span>
              <button
                type="button"
                className={buttonClass}
                onClick={onToggleFullscreen}
                disabled={!document.fullscreenEnabled}
                title={document.fullscreenEnabled ? "Toggle browser fullscreen (F11)" : "This browser does not allow the Fullscreen API."}
              >{fullscreen ? "Exit Full Screen" : "Full Screen"}</button>
            </div>
            <div className="gpu-control-row window-size-row" title="Browser presentation size is controlled by Display Scaling.">
              <label className={`${labelClass} field-label`} htmlFor="window-width">Window Size</label>
              <input id="window-width" className={`${entryClass} size-entry`} value={live.ResolutionX} readOnly disabled />
              <span className={labelClass}>x</span>
              <input aria-label="Window height" className={`${entryClass} size-entry`} value={live.ResolutionY} readOnly disabled />
            </div>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="fullscreen-size">FullScreen Size</label>
              <select id="fullscreen-size" className={selectClass} value="available" disabled title="Fullscreen automatically uses the available browser display area.">
                <option value="available">Available display area</option>
              </select>
            </div>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="internal-resolution">Internal Resolution</label>
              <select id="internal-resolution" className={selectClass} value="native" disabled title="Only the native PS1 renderer is available; presentation scaling does not add detail.">
                <option value="native">1: Native Resolution</option>
              </select>
            </div>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="brightness-profile">Brightness Profile</label>
              <select id="brightness-profile" className={selectClass} value="original" disabled title={unsupported("Brightness profiles")}>
                <option value="original">0: Original</option>
              </select>
            </div>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="blit-mode">Blit Mode</label>
              <select id="blit-mode" className={selectClass} value="canvas" disabled title="Canvas 2D is the fixed native presentation backend.">
                <option value="canvas">Canvas 2D</option>
              </select>
            </div>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="threading-mode">Threading Mode</label>
              <select id="threading-mode" className={selectClass} value="single" disabled title={unsupported("Renderer threading modes")}>
                <option value="single">0: 1-Thread</option>
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Framerate</legend>
          <div className="framerate-grid">
            <label className="check-label">
              <input type="checkbox" checked={showFps} onChange={(e) => setShowFps(e.target.checked)} />
              Show FPS
            </label>
            <label className="check-label" title={unsupported("Configurable frame limiting")}>
              <input type="checkbox" checked={false} disabled />
              Enable FPS Limit
            </label>
            <label className="check-label" title={unsupported("Frameskip")}>
              <input type="checkbox" checked={false} disabled />
              Enable Frameskip
            </label>
            <label className="check-label custom-fps" title={unsupported("Custom FPS and frameskip")}>
              <span className={labelClass}>Custom FPS (0=disabled)</span>
              <input className={`${entryClass} size-entry`} value={0} readOnly disabled />
            </label>
          </div>
        </fieldset>

        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Fullscreen Filters</legend>
          <div className="gpu-fields">
            <label className="check-label">
              <input type="checkbox" checked={bilinear} onChange={(e) => setBilinear(e.target.checked)} />
              Bilinear filter (presentation only)
            </label>
            <div className="gpu-control-row">
              <label className={`${labelClass} field-label`} htmlFor="filter-2d">Filter for 2D games</label>
              <select id="filter-2d" className={selectClass} value="none" disabled title={unsupported("2D post-processing filters")}>
                <option value="none">0: None</option>
              </select>
            </div>
            <div className="gpu-control-row shader-row">
              <label className={`${labelClass} field-label`} htmlFor="shader-effects">Shader Effects</label>
              <select id="shader-effects" className={selectClass} value="none" disabled title={unsupported("Shader effects")}>
                <option value="none">0: None</option>
              </select>
              <button type="button" className={buttonClass} disabled title={unsupported("Custom shaders")} aria-label="Select shader directory">...</button>
            </div>
          </div>
        </fieldset>
        <button
          type="button"
          className={`${buttonClass} dialog-defaults`}
          onClick={() => {
            setScale(DEFAULT_CONFIG.DisplayScale);
            setShowFps(DEFAULT_CONFIG.ShowFPS);
            setBilinear(DEFAULT_CONFIG.BilinearFilter);
          }}
        >Reset Display Defaults</button>
      </div>
    </Dialog>
  );
}
