import { describe, expect, test } from "bun:test";
import { GamepadInput } from "../src/ui/gamepad-input";
import { Machine } from "../src/core/machine";
import { DEFAULT_CONFIG } from "../src/state/config";

function standardGamepad() {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const effects: Array<{ duration: number; weak: number; strong: number }> = [];
  const device = {
    connected: true,
    buttons,
    axes: [0.25, -0.5, 0.75, -1],
    vibrationActuator: {
      playEffect: (_type: string, options: { duration: number; weakMagnitude: number; strongMagnitude: number }) => {
        effects.push({ duration: options.duration, weak: options.weakMagnitude, strong: options.strongMagnitude });
        return Promise.resolve("complete");
      },
    },
  } as unknown as Gamepad;
  return { device, buttons, effects };
}

describe("browser gamepad host input", () => {
  test("merges keyboard and standard gamepad independently and releases disconnects", () => {
    const { device, buttons } = standardGamepad();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { getGamepads: () => [device, null] } });
    try {
      const input = new GamepadInput();
      const machine = new Machine();
      const config = { ...DEFAULT_CONFIG, PadType1: 2 };
      input.setKeyboardButton(1, "Cross", true);
      buttons[9]!.pressed = true; // Start
      input.poll(machine, config);
      expect(machine.pads.pad1 & 0x4008).toBe(0);
      const joy = machine.joypad as unknown as { analog: boolean[]; axes: Uint8Array };
      expect(joy.analog[0]).toBe(true);
      expect(Array.from(joy.axes.slice(0, 4))).toEqual([223, 0, 159, 64]);

      device.connected = false;
      input.poll(machine, config);
      expect(machine.pads.pad1 & 0x4000).toBe(0); // keyboard remains held
      expect(machine.pads.pad1 & 0x0008).toBe(0x0008); // disconnected Start releases
      input.setKeyboardButton(1, "Cross", false);
      input.poll(machine, config);
      expect(machine.pads.pad1).toBe(0xffff);
      expect(Array.from(joy.axes.slice(0, 4))).toEqual([128, 128, 128, 128]);
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  test("routes rumble safely and stops it when the device disconnects", () => {
    const { device, effects } = standardGamepad();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { getGamepads: () => [device] } });
    try {
      const input = new GamepadInput();
      const machine = new Machine();
      input.poll(machine, DEFAULT_CONFIG);
      machine.joypad.rumble(0, true, 200);
      expect(effects.at(-1)).toEqual({ duration: 100, weak: 1, strong: 200 / 255 });
      device.connected = false;
      input.poll(machine, DEFAULT_CONFIG);
      expect(effects.at(-1)).toEqual({ duration: 0, weak: 0, strong: 0 });
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
