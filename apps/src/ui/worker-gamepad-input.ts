import type { WorkerRumbleState } from "../core/emulator-worker-protocol";
import { WORKER_PAD_BITS } from "../core/emulator-worker-protocol";
import type { PadButton, PsxConfig } from "../state/config";
import type { WorkerHost } from "./worker-host";

type Axes = [number, number, number, number];
const NEUTRAL_AXES: readonly [number, number, number, number] = [0, 0, 0, 0];
const EMPTY_GAMEPADS: readonly (Gamepad | null)[] = [];
const STANDARD_BUTTON_BITS = [
  WORKER_PAD_BITS.Cross, WORKER_PAD_BITS.Circle, WORKER_PAD_BITS.Square, WORKER_PAD_BITS.Triangle,
  WORKER_PAD_BITS.L1, WORKER_PAD_BITS.R1, WORKER_PAD_BITS.L2, WORKER_PAD_BITS.R2,
  WORKER_PAD_BITS.Select, WORKER_PAD_BITS.Start, WORKER_PAD_BITS.L3, WORKER_PAD_BITS.R3,
  WORKER_PAD_BITS.Up, WORKER_PAD_BITS.Down, WORKER_PAD_BITS.Left, WORKER_PAD_BITS.Right,
] as const;

function axis(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Browser input/haptics adapter which sends only changed pad snapshots to the host. */
export class WorkerGamepadInput {
  private readonly keyboardMasks = new Uint16Array(2);
  private readonly devices: Array<Gamepad | null> = [null, null];
  private readonly axes: [Axes, Axes] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  private readonly sent: Array<{ buttons: number; axes: Axes; connected: boolean; analog: boolean } | null> = [null, null];
  private readonly rumble: Array<{ small: boolean; large: number }> = [
    { small: false, large: 0 }, { small: false, large: 0 },
  ];
  private suspended = false;

  setKeyboardButton(port: 1 | 2, button: PadButton, pressed: boolean): void {
    const index = port - 1;
    const bit = WORKER_PAD_BITS[button];
    if (pressed) this.keyboardMasks[index] = this.keyboardMasks[index]! | bit;
    else this.keyboardMasks[index] = this.keyboardMasks[index]! & ~bit;
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  poll(host: WorkerHost, config: PsxConfig): void {
    let gamepads = EMPTY_GAMEPADS;
    if (!this.suspended && typeof navigator !== "undefined") {
      try { gamepads = navigator.getGamepads?.() ?? EMPTY_GAMEPADS; } catch { /* optional browser API */ }
    }
    for (let port = 0; port < 2; port++) {
      const enabled = (port === 0 ? config.PadType1 : config.PadType2) !== 0;
      const candidate = enabled ? gamepads[port] : null;
      const device = candidate?.connected ? candidate : null;
      this.setDevice(port, device);
      let gamepadMask = 0;
      const axes = this.axes[port]!;
      if (device) {
        for (let index = 0; index < STANDARD_BUTTON_BITS.length; index++) {
          const button = device.buttons[index];
          if (button && (button.pressed || button.value > 0.5)) gamepadMask |= STANDARD_BUTTON_BITS[index]!;
        }
        axes[0] = axis(device.axes[2]);
        axes[1] = axis(device.axes[3]);
        axes[2] = axis(device.axes[0]);
        axes[3] = axis(device.axes[1]);
      } else {
        axes[0] = NEUTRAL_AXES[0];
        axes[1] = NEUTRAL_AXES[1];
        axes[2] = NEUTRAL_AXES[2];
        axes[3] = NEUTRAL_AXES[3];
      }
      const keyboardMask = enabled && !this.suspended ? this.keyboardMasks[port]! : 0;
      const next = {
        buttons: 0xffff & ~(keyboardMask | gamepadMask),
        axes,
        connected: enabled,
        analog: (port === 0 ? config.PadType1 : config.PadType2) === 2,
      };
      const previous = this.sent[port];
      if (previous && previous.buttons === next.buttons && previous.connected === next.connected &&
          previous.analog === next.analog && previous.axes.every((value, index) => value === axes[index])) continue;
      host.setPad((port + 1) as 1 | 2, next);
      this.sent[port] = { ...next, axes: [...axes] };
    }
  }

  applyRumble(states: readonly [WorkerRumbleState, WorkerRumbleState]): void {
    for (const state of states) {
      const previous = this.rumble[state.port]!;
      if (previous.small === state.small && previous.large === state.large) continue;
      previous.small = state.small;
      previous.large = state.large;
      const device = this.devices[state.port];
      if (device) this.playEffect(device, state.small, state.large, 100);
    }
  }

  release(host: WorkerHost): void {
    this.keyboardMasks.fill(0);
    this.sent[0] = this.sent[1] = null;
    for (let port = 0; port < 2; port++) this.setDevice(port, null);
    host.releaseInput();
  }

  private setDevice(port: number, device: Gamepad | null): void {
    const previous = this.devices[port];
    if (previous === device) return;
    if (previous) this.playEffect(previous, false, 0, 0);
    this.devices[port] = device;
  }

  private playEffect(device: Gamepad, small: boolean, large: number, duration: number): void {
    const actuator = device.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== "function") return;
    try {
      void actuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration,
        weakMagnitude: small ? 1 : 0,
        strongMagnitude: Math.max(0, Math.min(1, large / 255)),
      }).catch(() => {});
    } catch { /* haptics must not interrupt emulation */ }
  }
}
