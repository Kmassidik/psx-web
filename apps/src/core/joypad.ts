/** SIO0 digital controller: serial read command and active-low button bytes. */
export class Joypad {
  private readonly rx: number[] = [];
  private command = 0;
  private mode = 0;
  private ctrl = 0;
  private baud = 0x88;

  constructor(private readonly pads: { pad1: number; pad2: number }) {}

  read(address: number): number | undefined {
    switch (address) {
      case 0x1f80_1040:
        return this.rx.length > 0 ? this.rx.shift()! : 0xff;
      case 0x1f80_1044:
        return 0x05 | (this.rx.length > 0 ? 0x02 : 0);
      case 0x1f80_1048: return this.mode;
      case 0x1f80_104a: return this.ctrl;
      case 0x1f80_104e: return this.baud;
      default: return undefined;
    }
  }

  write(address: number, value: number): boolean {
    switch (address) {
      case 0x1f80_1040:
        this.transfer(value & 0xff);
        return true;
      case 0x1f80_1048:
        this.mode = value & 0xffff;
        return true;
      case 0x1f80_104a:
        if ((value & 0x40) !== 0) {
          this.mode = this.ctrl = 0;
          this.baud = 0x88;
          this.rx.length = 0;
          this.command = 0;
        }
        this.ctrl = value & 0xffff;
        return true;
      case 0x1f80_104e:
        this.baud = value & 0xffff;
        return true;
      default:
        return false;
    }
  }

  private transfer(value: number): void {
    if (value === 0x01) {
      this.command = 1;
      this.rx.push(0xff);
      return;
    }
    if (value === 0x42 && this.command === 1) {
      this.command = 2;
      this.rx.push(0x41);
      return;
    }
    if (this.command === 2) {
      this.command = 3;
      this.rx.push(0x5a);
      return;
    }
    if (this.command === 3) {
      this.command = 4;
      this.rx.push(this.pads.pad1 & 0xff);
      return;
    }
    if (this.command === 4) {
      this.command = 0;
      this.rx.push((this.pads.pad1 >>> 8) & 0xff);
      return;
    }
    this.command = 0;
    this.rx.push(0xff);
  }
}
