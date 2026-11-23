/** Browser gamepad polling and haptics, merged with the configured keyboard state. */
import type { JoypadPort } from "../core/joypad";
import type { Machine } from "../core/machine";
import type { PadButton, PsxConfig } from "../state/config";

type Axes = [number, number, number, number];

const NEUTRAL_AXES: readonly [number, number, number, number] = [0, 0, 0, 0];
const EMPTY_GAMEPADS: readonly (Gamepad | null)[] = [];

const PAD_BITS: Record<PadButton, number> = {
  Select: 0x0001, L3: 0x0002, R3: 0x0004, Start: 0x0008,
  Up: 0x0010, Right: 0x0020, Down: 0x0040, Left: 0x0080,
  L2: 0x0100, R2: 0x0200, L1: 0x0400, R1: 0x0800,
  Triangle: 0x1000, Circle: 0x2000, Cross: 0x4000, Square: 0x8000,
};

/** W3C standard-layout button order, expressed as active-low PS1 mask bits. */
const STANDARD_BUTTON_BITS = [
  PAD_BITS.Cross, PAD_BITS.Circle, PAD_BITS.Square, PAD_BITS.Triangle,
  PAD_BITS.L1, PAD_BITS.R1, PAD_BITS.L2, PAD_BITS.R2,
  PAD_BITS.Select, PAD_BITS.Start, PAD_BITS.L3, PAD_BITS.R3,
  PAD_BITS.Up, PAD_BITS.Down, PAD_BITS.Left, PAD_BITS.Right,
] as const;

function normalizedAxis(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

export class GamepadInput {
  private readonly keyboardMasks = new Uint16Array(2);
  private readonly devices: Array<Gamepad | null> = [null, null];
  private readonly axes: [Axes, Axes] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  private readonly analogModes: Array<boolean | null> = [null, null];
  private machine: Machine | null = null;
  private suspended = false;

  private readonly onRumble = (port: JoypadPort, small: boolean, large: number): void => {
    const device = this.devices[port];
    if (device) this.playEffect(device, small, large, 100);
  };

  attach(machine: Machine): void {
    if (this.machine !== machine) {
      this.machine = machine;
      this.analogModes[0] = this.analogModes[1] = null;
    }
    machine.joypad.rumble = this.onRumble;
  }

  setKeyboardButton(port: 1 | 2, button: PadButton, pressed: boolean): void {
    const index = port - 1;
    const bit = PAD_BITS[button];
    if (pressed) this.keyboardMasks[index] = this.keyboardMasks[index]! | bit;
    else this.keyboardMasks[index] = this.keyboardMasks[index]! & ~bit;
  }

  /** Ignore polled devices until focus returns; callers also release immediately. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  poll(machine: Machine, config: PsxConfig): void {
    this.attach(machine);
    let gamepads = EMPTY_GAMEPADS;
    if (!this.suspended && typeof navigator !== "undefined") {
      try {
        gamepads = navigator.getGamepads?.() ?? EMPTY_GAMEPADS;
      } catch {
        // Privacy settings and unsupported contexts can reject gamepad access.
      }
    }

    for (let port = 0; port < 2; port++) {
      const enabled = (port === 0 ? config.PadType1 : config.PadType2) !== 0;
      const candidate = enabled ? gamepads[port] : null;
      const device = candidate?.connected ? candidate : null;
      this.setDevice(port as JoypadPort, device);

      let gamepadMask = 0;
      const axes = this.axes[port]!;
      if (device) {
        for (let index = 0; index < STANDARD_BUTTON_BITS.length; index++) {
          const button = device.buttons[index];
          if (button && (button.pressed || button.value > 0.5)) gamepadMask |= STANDARD_BUTTON_BITS[index]!;
        }
        // Browser order is left X/Y then right X/Y; SIO0 expects right then left.
        axes[0] = normalizedAxis(device.axes[2]);
        axes[1] = normalizedAxis(device.axes[3]);
        axes[2] = normalizedAxis(device.axes[0]);
        axes[3] = normalizedAxis(device.axes[1]);
      }

      const analog = (port === 0 ? config.PadType1 : config.PadType2) === 2;
      if (this.analogModes[port] !== analog) {
        machine.joypad.setAnalogMode(port as JoypadPort, analog);
        this.analogModes[port] = analog;
      }
      const keyboardMask = enabled && !this.suspended ? this.keyboardMasks[port]! : 0;
      const activeLow = 0xffff & ~(keyboardMask | gamepadMask);
      if (port === 0) machine.pads.pad1 = activeLow;
      else machine.pads.pad2 = activeLow;
      machine.joypad.setAxes(port as JoypadPort, device ? axes : NEUTRAL_AXES);
    }
  }

  /** Release every source, neutralize both sticks, and stop current vibration. */
  release(machine: Machine | null): void {
    this.keyboardMasks.fill(0);
    for (let port = 0; port < 2; port++) {
      this.setDevice(port as JoypadPort, null);
    }
    if (!machine) return;
    machine.pads.pad1 = machine.pads.pad2 = 0xffff;
    machine.joypad.setAxes(0, NEUTRAL_AXES);
    machine.joypad.setAxes(1, NEUTRAL_AXES);
  }

  private setDevice(port: JoypadPort, device: Gamepad | null): void {
    const previous = this.devices[port];
    if (previous === device) return;
    if (previous) this.playEffect(previous, false, 0, 0);
    this.devices[port] = device;
  }

  private playEffect(device: Gamepad, small: boolean, large: number, duration: number): void {
    const actuator = device.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== "function") return;
    try {
      const effect = actuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration,
        weakMagnitude: small ? 1 : 0,
        strongMagnitude: Math.max(0, Math.min(1, large / 255)),
      });
      void effect.catch(() => {});
    } catch {
      // Haptics are optional and must never interrupt emulation.
    }
  }
}
