/** Digital keyboard mapping for the two controller ports. */
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  DEFAULT_PAD1_KEYS, DEFAULT_PAD2_KEYS, PAD_BUTTONS,
  type KeyBindings, type PadButton,
} from "../../state/config";
import { setConfig, useApp } from "../store";
import { Dialog, buttonClass, selectClass } from "./Dialog";

const PAD_SLOTS = ["Port 1: Pad 1", "Port 2: Pad 1"] as const;
const PAD_TYPES = ["[SXXX-0000] Disabled", "[SCPH-1080] Digital"] as const;

function keyLabel(code: string): string {
  if (!code) return "Not set";
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export interface GamepadConfigDialogProps {
  initialPort: 1 | 2;
  onClose: () => void;
}

export function GamepadConfigDialog({ initialPort, onClose }: GamepadConfigDialogProps) {
  const live = useApp((s) => s.config);
  const [selected, setSelected] = useState(initialPort - 1);
  const [pad1Type, setPad1Type] = useState(live.PadType1);
  const [pad2Type, setPad2Type] = useState(live.PadType2);
  const [pad1Bindings, setPad1Bindings] = useState<KeyBindings>(() => ({ ...live.Pad1Bindings }));
  const [pad2Bindings, setPad2Bindings] = useState<KeyBindings>(() => ({ ...live.Pad2Bindings }));
  const [capturing, setCapturing] = useState<PadButton | null>(null);
  const [message, setMessage] = useState("Click a binding, then press a key. Delete clears; Escape cancels.");
  const current = selected === 0 ? pad1Bindings : pad2Bindings;
  const padType = selected === 0 ? pad1Type : pad2Type;
  const setCurrent = (next: KeyBindings) => {
    if (selected === 0) setPad1Bindings(next);
    else setPad2Bindings(next);
  };

  const capture = (event: ReactKeyboardEvent<HTMLInputElement>, button: PadButton) => {
    if (capturing !== button) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setCapturing(button);
      }
      return;
    }
    if (event.key === "Tab") {
      setCapturing(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      setMessage("Binding capture cancelled.");
      return;
    }
    if (event.code === "F11") {
      setMessage("F11 is reserved for fullscreen. Choose another key.");
      return;
    }
    const next = { ...current };
    if (event.key === "Delete") {
      next[button] = "";
    } else {
      for (const other of PAD_BUTTONS) {
        if (other !== button && next[other] === event.code) next[other] = "";
      }
      next[button] = event.code;
    }
    setCurrent(next);
    setCapturing(null);
    setMessage(`${button} set to ${keyLabel(next[button])}.`);
  };

  return (
    <Dialog
      title="Config Gamepad"
      onClose={onClose}
      onOk={() => setConfig({
        PadType1: pad1Type,
        PadType2: pad2Type,
        Pad1Bindings: pad1Bindings,
        Pad2Bindings: pad2Bindings,
      })}
    >
      <div className="gamepad-content">
        <div className="gamepad-selectors">
          <select
            className={selectClass}
            aria-label="Gamepad slot"
            value={selected}
            onChange={(e) => {
              setSelected(Number(e.target.value));
              setCapturing(null);
            }}
          >
            {PAD_SLOTS.map((slot, i) => <option key={slot} value={i}>{slot}</option>)}
          </select>
          <select
            className={selectClass}
            aria-label="Gamepad type"
            value={padType}
            onChange={(e) => {
              const type = Number(e.target.value);
              if (selected === 0) setPad1Type(type);
              else setPad2Type(type);
            }}
          >
            {PAD_TYPES.map((type, i) => <option key={type} value={i}>{type}</option>)}
            <option value={2} disabled title="Analog and vibration are not connected to the controller core.">[SCPH-1200] DualShock (unsupported)</option>
          </select>
        </div>

        <div className="gamepad-bindings">
          {PAD_BUTTONS.map((button) => (
            <label key={button} className="binding-field">
              <span>{button}</span>
              <input
                className={`gtk-entry binding-entry${capturing === button ? " is-capturing" : ""}`}
                readOnly
                value={capturing === button ? "Press key…" : keyLabel(current[button])}
                aria-label={`${button} binding`}
                title="Click or press Enter, then press a key. Delete clears the binding."
                onClick={() => setCapturing(button)}
                onBlur={() => { if (capturing === button) setCapturing(null); }}
                onKeyDown={(event) => capture(event, button)}
              />
            </label>
          ))}
        </div>

        <div className="gamepad-footer">
          <span className="edit-button-label" role="status">
            {capturing ? `EDIT BUTTON: ${capturing}` : message}
          </span>
          <div className="gamepad-default-actions">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setCurrent(Object.fromEntries(PAD_BUTTONS.map((button) => [button, ""])) as KeyBindings);
                setCapturing(null);
                setMessage(`Cleared Port ${selected + 1} bindings.`);
              }}
            >Clear</button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setCurrent({ ...(selected === 0 ? DEFAULT_PAD1_KEYS : DEFAULT_PAD2_KEYS) });
                setCapturing(null);
                setMessage(`Restored Port ${selected + 1} defaults.`);
              }}
            >Default</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
