/**
 * GamepadConfigDialog — clone of the blueprint's window_config_gamepad
 * ("Config Gamepad"): port/pad picker (liststore_pads), pad type combo
 * (liststore_padtypes), static key-binding grid (capture is a later ticket),
 * Clear/Default/Cancel/OK row.
 */
import { useState } from "react";
import { setConfig } from "../store";
import { Dialog, buttonClass, frameClass, frameTitleClass, labelClass, selectClass } from "./Dialog";

/** liststore_padtypes rows, verbatim; index = PsxConfig PadType1/PadType2 value. */
const PAD_TYPES = [
  "[SXXX-0000] Disabled",
  "[SCPH-1080] Digital",
  "[SCPH-1200] DualShock (F5)",
] as const;

/** liststore_pads rows, verbatim. */
const PAD_SLOTS = [
  "Port 1: Pad 1",
  "Port 1: Pad 2",
  "Port 1: Pad 3",
  "Port 1: Pad 4",
  "Port 2: Pad 1",
  "Port 2: Pad 2",
  "Port 2: Pad 3",
  "Port 2: Pad 4",
] as const;

/** Key-binding grid buttons, verbatim blueprint handlers (l2..r3, axes). */
const PAD_BUTTONS = [
  "L2", "R2", "L1", "R1",
  "Triangle", "Circle", "X", "Square",
  "Select", "Start", "L3", "R3",
  "Up", "Down", "Left", "Right",
  "X1 Axis", "Y1 Axis", "X2 Axis", "Y2 Axis",
] as const;

export interface GamepadConfigDialogProps {
  onClose: () => void;
}

/** Clone of window_config_gamepad; binding grid is static UI this phase. */
export function GamepadConfigDialog({ onClose }: GamepadConfigDialogProps) {
  const [selected, setSelected] = useState(0); // liststore_pads index
  const [pad1, setPad1] = useState<number | null>(null); // draft, null = unchanged
  const [pad2, setPad2] = useState<number | null>(null);

  const padType = selected < 4 ? (pad1 ?? 0) : (pad2 ?? 0);
  const pad = pad1 !== null ? { PadType1: pad1 } : pad2 !== null ? { PadType2: pad2 } : {};

  return (
    <Dialog title="Config Gamepad" onClose={onClose} onOk={() => setConfig(pad)}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className={labelClass}>Pad</span>
          <select className={selectClass} value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {PAD_SLOTS.map((slot, i) => (
              <option key={slot} value={i}>
                {slot}
              </option>
            ))}
          </select>
          <span className={labelClass}>Type</span>
          <select
            className={selectClass}
            value={padType}
            onChange={(e) =>
              selected < 4 ? setPad1(Number(e.target.value)) : setPad2(Number(e.target.value))
            }
          >
            {PAD_TYPES.map((t, i) => (
              <option key={t} value={i}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <fieldset className={frameClass}>
          <legend className={frameTitleClass}>Key Bindings</legend>
          <div className="grid grid-cols-4 gap-2">
            {PAD_BUTTONS.map((btn) => (
              <label key={btn} className="flex items-center justify-between gap-1 text-[12px]">
                <span className={labelClass}>{btn}</span>
                <input
                  className="w-24 border border-[#2a2d31] bg-[#1b1d20] px-1.5 py-0.5 text-[12px] text-[#d6d3c8] focus:border-[#35507a] focus:outline-none"
                  readOnly
                  value="—"
                  title="Binding capture lands in a later ticket"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2">
          <button className={buttonClass}>Clear</button>
          <button className={buttonClass}>Default</button>
        </div>
      </div>
    </Dialog>
  );
}
