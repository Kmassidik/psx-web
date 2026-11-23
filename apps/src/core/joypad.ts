import { MemoryCard, type MemoryCardImage } from "./memory-card";

/** SIO0 serial bus and standard digital/analog controller peripherals. */
const JOY_DATA = 0x1f80_1040;
const JOY_STAT = 0x1f80_1044;
const JOY_MODE = 0x1f80_1048;
const JOY_CTRL = 0x1f80_104a;
const JOY_BAUD = 0x1f80_104e;

const CTRL_TXEN = 1 << 0;
const CTRL_DTR = 1 << 1;
const CTRL_ERRRST = 1 << 4;
const CTRL_INTRST = 1 << 6;
const CTRL_DSRIEN = 1 << 12;
const CTRL_PORT = 1 << 13;
const CTRL_READ_MASK = 0x3f07;
const MODE_READ_MASK = 0x013f;

export type JoypadPort = 0 | 1;

/**
 * SIO0 controller port and a PS1 dual-shock peripheral. Transfers complete
 * immediately; /ACK is represented by STAT.7 until the next byte or ERRRST.
 * The peripheral starts in digital mode, but supports the standard config
 * commands used to enable analog sticks and either rumble motor.
 */
export class Joypad {
  /** SIO0 /ACK interrupt hook (I_STAT line 7). */
  irqFire: (line: number) => void = () => {};
  /** Host actuator hook: small motor is on/off, large motor is 0..255. */
  rumble: (port: JoypadPort, small: boolean, large: number) => void = () => {};

  private readonly rx: number[] = [];
  private mode = 0;
  private ctrl = 0;
  private baud = 0x88;
  private ack = false;
  private irq = false;
  private ackDelay = 0;
  private ackIrqPending = false;

  private readonly connected = [true, true];
  private readonly cards: Array<MemoryCard | undefined> = [undefined, undefined];
  private readonly analog = [false, false];
  private readonly analogLocked = [false, false];
  private readonly config = [false, false];
  private readonly axes = new Uint8Array(8).fill(0x80);
  private readonly rumbleMap = new Uint8Array(12).fill(0xff);
  private readonly oldRumble = [true, true];
  private readonly smallMotor = [false, false];
  private readonly largeMotor = new Uint8Array(2);

  private response: number[] = [];
  private sent: number[] = [];
  private packetIndex = 0;
  private packetPort: JoypadPort = 0;
  private command = 0;
  private addressed = false;
  private cardTransaction = false;

  constructor(private readonly pads: { pad1: number; pad2: number }) {}

  read(address: number): number | undefined {
    switch (address) {
      case JOY_DATA:
        return this.rx.length > 0 ? this.rx.shift()! : 0xff;
      case JOY_STAT:
        return 0x05 | (this.rx.length > 0 ? 0x02 : 0) |
          (this.ack ? 0x80 : 0) | (this.irq ? 0x200 : 0);
      case JOY_MODE: return this.mode;
      case JOY_CTRL: return this.ctrl;
      case JOY_BAUD: return this.baud;
      default: return undefined;
    }
  }

  write(address: number, value: number): boolean {
    switch (address) {
      case JOY_DATA:
        this.transfer(value & 0xff);
        return true;
      case JOY_MODE:
        this.mode = value & MODE_READ_MASK;
        return true;
      case JOY_CTRL:
        this.writeControl(value & 0xffff);
        return true;
      case JOY_BAUD:
        this.baud = value & 0xffff;
        return true;
      default:
        return false;
    }
  }

  /** Connect/disconnect a physical port; a reconnect resets peripheral state. */
  setConnected(port: JoypadPort, connected: boolean): void {
    if (this.connected[port] === connected) return;
    this.connected[port] = connected;
    this.resetPeripheral(port);
    this.setMotors(port, false, 0);
    if (!connected && this.packetPort === port) this.resetTransaction();
  }

  /** Insert a raw card image, or a newly formatted card when omitted. */
  attachMemoryCard(port: JoypadPort, image?: MemoryCardImage): MemoryCard {
    const card = new MemoryCard(image);
    this.cards[port] = card;
    if (this.cardTransaction && this.packetPort === port) this.resetTransaction();
    return card;
  }

  /** Remove a card without affecting the controller attached to the same port. */
  detachMemoryCard(port: JoypadPort): void {
    this.cards[port] = undefined;
    if (this.cardTransaction && this.packetPort === port) this.resetTransaction();
  }

  /** Import into an inserted card, or insert a card when the slot is empty. */
  importMemoryCard(port: JoypadPort, image: MemoryCardImage): MemoryCard {
    const card = this.cards[port];
    if (!card) return this.attachMemoryCard(port, image);
    card.import(image);
    if (this.cardTransaction && this.packetPort === port) this.resetTransaction();
    return card;
  }

  /** Return a defensive raw-image copy, or undefined for an empty slot. */
  exportMemoryCard(port: JoypadPort): Uint8Array | undefined {
    return this.cards[port]?.export();
  }

  /** Format an inserted card; returns false when the slot is empty. */
  formatMemoryCard(port: JoypadPort): boolean {
    const card = this.cards[port];
    if (!card) return false;
    card.format();
    if (this.cardTransaction && this.packetPort === port) this.resetTransaction();
    return true;
  }

  /** Set normalized axes in wire order: right X/Y, then left X/Y (-1..1). */
  setAxes(port: JoypadPort, values: readonly [number, number, number, number]): void {
    const offset = port * 4;
    for (let i = 0; i < 4; i++) {
      const value = values[i]!;
      const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.axes[offset + i] = Math.round((clamped + 1) * 127.5);
    }
  }

  /** Model the controller's Analog button, including a software mode lock. */
  setAnalogMode(port: JoypadPort, enabled: boolean): void {
    if (this.analogLocked[port]) return;
    this.analog[port] = enabled;
    this.config[port] = false;
    this.resetRumble(port);
  }

  private writeControl(value: number): void {
    if ((value & CTRL_INTRST) !== 0) {
      this.mode = this.ctrl = 0;
      this.baud = 0x88;
      this.rx.length = 0;
      this.ack = this.irq = false;
      this.ackDelay = 0;
      this.ackIrqPending = false;
      this.resetTransaction();
      return;
    }

    if ((value & CTRL_ERRRST) !== 0) {
      this.ack = this.irq = false;
      this.ackDelay = 0;
      this.ackIrqPending = false;
    }
    const next = value & CTRL_READ_MASK;
    const selectionChanged = (next & CTRL_PORT) !== (this.ctrl & CTRL_PORT);
    const chipSelectChanged = (next & CTRL_DTR) !== (this.ctrl & CTRL_DTR);
    if (selectionChanged || chipSelectChanged) this.resetTransaction();
    this.ctrl = next;
  }

  private transfer(value: number): void {
    this.ack = false;
    this.ackDelay = 0;
    this.ackIrqPending = false;
    if ((this.ctrl & (CTRL_TXEN | CTRL_DTR)) !== (CTRL_TXEN | CTRL_DTR)) {
      this.receive(0xff);
      return;
    }

    const port = ((this.ctrl & CTRL_PORT) !== 0 ? 1 : 0) as JoypadPort;
    if (this.packetIndex === 0) {
      this.packetPort = port;
      this.sent = [value];
      this.response = [0xff];
      this.command = 0;
      this.cardTransaction = value === 0x81;
      this.addressed = this.cardTransaction ? this.cards[port] !== undefined :
        value === 0x01 && this.connected[port] === true;
      this.packetIndex = 1;
      this.receive(0xff);
      if (this.addressed) this.acknowledge();
      return;
    }

    const disconnected = this.cardTransaction ? this.cards[port] === undefined : !this.connected[port];
    if (port !== this.packetPort || !this.addressed || disconnected) {
      this.receive(0xff);
      return;
    }

    const index = this.packetIndex;
    this.sent.push(value);
    if (this.cardTransaction) {
      const card = this.cards[port]!;
      this.receive(card.transfer(value));
      this.packetIndex++;
      if (card.ack) this.acknowledge();
      return;
    }
    if (index === 1) {
      this.command = value;
      this.buildResponse(port, value);
    } else {
      this.applyParameter(port, index, value);
    }

    this.receive(this.response[index] ?? 0xff);
    this.packetIndex++;
    if (index < this.response.length - 1) this.acknowledge();
    if (index === this.response.length - 1 && this.command === 0x42) {
      this.updateRumble(port);
    }
  }

  private buildResponse(port: JoypadPort, command: number): void {
    if (this.config[port]) {
      this.buildConfigResponse(port, command);
      return;
    }
    if (command !== 0x42 && command !== 0x43) {
      this.response = [0xff, 0xff];
      return;
    }

    const buttons = port === 0 ? this.pads.pad1 : this.pads.pad2;
    const data = [buttons & 0xff, (buttons >>> 8) & 0xff];
    if (this.analog[port]) {
      for (let i = 0; i < 4; i++) data.push(this.axes[port * 4 + i]!);
    } else if (command === 0x42) {
      // Mapping motors onto later command bytes extends an otherwise digital
      // packet and increases the ID's following-halfword count accordingly.
      let lastCommandByte = 4;
      for (let i = 0; i < 6; i++) {
        if (this.rumbleMap[port * 6 + i]! <= 1) lastCommandByte = Math.max(lastCommandByte, i + 3);
      }
      while (data.length < lastCommandByte - 2) data.push(0);
      if ((data.length & 1) !== 0) data.push(0);
    }
    const id = this.analog[port] ? 0x73 : (0x40 | (data.length >>> 1));
    this.response = [0xff, id, 0x5a, ...data];
  }

  private buildConfigResponse(port: JoypadPort, command: number): void {
    let data = [0, 0, 0, 0, 0, 0];
    if (command === 0x42) {
      const buttons = port === 0 ? this.pads.pad1 : this.pads.pad2;
      data = [buttons & 0xff, (buttons >>> 8) & 0xff];
      for (let i = 0; i < 4; i++) data.push(this.axes[port * 4 + i]!);
    } else if (command === 0x45) {
      data = [0x01, 0x02, this.analog[port] ? 1 : 0, 0x02, 0x01, 0x00];
    } else if (command === 0x47) {
      data = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00];
    } else if (command === 0x4d) {
      for (let i = 0; i < 6; i++) data[i] = this.rumbleMap[port * 6 + i]!;
    }
    this.response = [0xff, 0xf3, 0x5a, ...data];
  }

  private applyParameter(port: JoypadPort, index: number, value: number): void {
    if (index === 3 && this.command === 0x43) {
      this.config[port] = value !== 0;
      if (this.config[port]) this.oldRumble[port] = false;
      return;
    }
    if (!this.config[port]) return;

    if (this.command === 0x44) {
      if (index === 3 && value <= 1) this.analog[port] = value !== 0;
      if (index === 4) this.analogLocked[port] = (value & 3) === 3;
    } else if (this.command === 0x46 && index === 3) {
      const response = value === 0 ? [0x01, 0x02, 0x00, 0x0a] :
        value === 1 ? [0x01, 0x01, 0x01, 0x14] : [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) this.response[index + 2 + i] = response[i]!;
    } else if (this.command === 0x4c && index === 3) {
      this.response[6] = value === 0 ? 0x04 : value === 1 ? 0x07 : 0;
    } else if (this.command === 0x48 && index === 3) {
      this.response[7] = value <= 1 ? 1 : 0;
    } else if (this.command === 0x4d && index >= 3 && index <= 8) {
      this.rumbleMap[port * 6 + index - 3] = value;
    }
  }

  private updateRumble(port: JoypadPort): void {
    let small = false;
    let large = 0;
    let mapped = false;
    for (let i = 0; i < 6; i++) {
      const mapping = this.rumbleMap[port * 6 + i]!;
      const value = this.sent[i + 3] ?? 0;
      if (mapping === 0) {
        small ||= (value & 1) !== 0;
        mapped = true;
      } else if (mapping === 1) {
        large = Math.max(large, value);
        mapped = true;
      }
    }
    if (!mapped && this.oldRumble[port] && !this.config[port]) {
      const smallControl = this.sent[3] ?? 0;
      const largeControl = this.sent[4] ?? 0;
      small = (smallControl & 0xc0) === 0x40 && (largeControl & 1) !== 0;
    }
    this.setMotors(port, small, large);
  }

  private setMotors(port: JoypadPort, small: boolean, large: number): void {
    if (this.smallMotor[port] === small && this.largeMotor[port] === large) return;
    this.smallMotor[port] = small;
    this.largeMotor[port] = large;
    this.rumble(port, small, large);
  }

  private resetRumble(port: JoypadPort): void {
    this.rumbleMap.fill(0xff, port * 6, port * 6 + 6);
    this.oldRumble[port] = false;
    this.setMotors(port, false, 0);
  }

  private resetPeripheral(port: JoypadPort): void {
    this.analog[port] = this.analogLocked[port] = this.config[port] = false;
    this.rumbleMap.fill(0xff, port * 6, port * 6 + 6);
    this.oldRumble[port] = true;
  }

  private resetTransaction(): void {
    this.ack = false;
    this.cards[this.packetPort]?.reset();
    this.response = [];
    this.sent = [];
    this.packetIndex = 0;
    this.command = 0;
    this.addressed = false;
    this.cardTransaction = false;
  }

  private acknowledge(): void {
    this.ackDelay = 100;
    this.ackIrqPending = (this.ctrl & CTRL_DSRIEN) !== 0;
  }

  /** Advance the hardware acknowledge delay in CPU cycles. */
  tick(cycles: number): void {
    if (this.ackDelay === 0) return;
    this.ackDelay = Math.max(0, this.ackDelay - cycles);
    if (this.ackDelay !== 0) return;
    this.ack = true;
    if (this.ackIrqPending) {
      this.ackIrqPending = false;
      this.irq = true;
      this.irqFire(7);
    }
  }

  private receive(value: number): void {
    if (this.rx.length === 8) this.rx[7] = value;
    else this.rx.push(value);
  }
}

