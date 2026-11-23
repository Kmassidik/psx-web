export const MEMORY_CARD_SIZE = 128 * 1024;
export const MEMORY_CARD_SECTOR_SIZE = 128;
export const MEMORY_CARD_SECTOR_COUNT = MEMORY_CARD_SIZE / MEMORY_CARD_SECTOR_SIZE;

const ID_REPLIES = [0x5a, 0x5d, 0x5c, 0x5d, 0x04, 0x00, 0x00, 0x80];

export type MemoryCardImage = Uint8Array | ArrayBuffer;

/** Build the raw 128 KiB image produced for a newly formatted card. */
export function createFormattedMemoryCard(): Uint8Array {
  const image = new Uint8Array(MEMORY_CARD_SIZE);
  image.fill(0xff);

  const checksum = (frame: number): void => {
    const offset = frame * MEMORY_CARD_SECTOR_SIZE;
    let value = 0;
    for (let i = 0; i < 127; i++) value ^= image[offset + i]!;
    image[offset + 127] = value;
  };
  const header = (frame: number): void => {
    const offset = frame * MEMORY_CARD_SECTOR_SIZE;
    image.fill(0, offset, offset + MEMORY_CARD_SECTOR_SIZE);
    image[offset] = 0x4d; // M
    image[offset + 1] = 0x43; // C
    checksum(frame);
  };

  header(0);
  for (let frame = 1; frame <= 15; frame++) {
    const offset = frame * MEMORY_CARD_SECTOR_SIZE;
    image.fill(0, offset, offset + MEMORY_CARD_SECTOR_SIZE);
    image[offset] = 0xa0; // free, freshly formatted
    image[offset + 8] = image[offset + 9] = 0xff;
    checksum(frame);
  }
  for (let frame = 16; frame <= 35; frame++) {
    const offset = frame * MEMORY_CARD_SECTOR_SIZE;
    image.fill(0, offset, offset + MEMORY_CARD_SECTOR_SIZE);
    image.fill(0xff, offset, offset + 4); // no broken sector
    checksum(frame);
  }
  header(63); // write-test frame
  return image;
}

/**
 * Standard Sony 128 KiB memory card. This class contains only the card and its
 * byte-at-a-time SIO protocol state; persistence belongs to the host.
 */
export class MemoryCard {
  private image = createFormattedMemoryCard();
  private flag = 0x08;
  private command = 0;
  private step = 0;
  private started = false;
  private active = false;
  private sector = 0;
  private previous = 0;
  private checksum = 0;
  private receivedChecksum = 0;
  private readonly writeData = new Uint8Array(MEMORY_CARD_SECTOR_SIZE);
  private lastAck = false;

  constructor(image?: MemoryCardImage) {
    if (image !== undefined) this.import(image);
  }

  /** Replace the card contents with a freshly formatted filesystem. */
  format(): void {
    this.image = createFormattedMemoryCard();
    this.flag = 0x08;
    this.reset();
  }

  /** Import an exact raw 128 KiB card image, copying the caller's bytes. */
  import(image: MemoryCardImage): void {
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
    if (bytes.byteLength !== MEMORY_CARD_SIZE) {
      throw new RangeError(`Memory card image must be ${MEMORY_CARD_SIZE} bytes`);
    }
    const start = bytes.byteOffset;
    this.image = new Uint8Array(bytes.buffer.slice(start, start + MEMORY_CARD_SIZE));
    this.flag = 0x08;
    this.reset();
  }

  /** Export a defensive copy suitable for host persistence or download. */
  export(): Uint8Array {
    return this.image.slice();
  }

  /** End the current SIO packet without changing the card contents or FLAG. */
  reset(): void {
    this.command = 0;
    this.step = 0;
    this.started = false;
    this.active = false;
    this.sector = 0;
    this.previous = 0;
    this.checksum = 0;
    this.receivedChecksum = 0;
    this.lastAck = false;
  }

  /** Whether the most recent transferred byte asserted /ACK. */
  get ack(): boolean {
    return this.lastAck;
  }

  /** Transfer the command byte and subsequent bytes following SIO address 81h. */
  transfer(value: number): number {
    value &= 0xff;
    if (!this.active) {
      if (this.started) {
        this.lastAck = false;
        return 0xff;
      }
      this.started = true;
      this.command = value;
      this.step = 0;
      this.previous = value;
      this.active = value === 0x52 || value === 0x53 || value === 0x57;
      this.lastAck = this.active;
      return this.flag;
    }
    if (this.command !== 0x52 && this.command !== 0x53 && this.command !== 0x57) {
      this.lastAck = false;
      return 0xff;
    }

    this.step++;
    let reply: number;
    if (this.command === 0x53) reply = this.transferId();
    else if (this.command === 0x52) reply = this.transferRead(value);
    else reply = this.transferWrite(value);
    this.previous = value;
    return reply;
  }

  private transferId(): number {
    const index = this.step - 1;
    this.lastAck = index < ID_REPLIES.length - 1;
    if (!this.lastAck) this.active = false;
    return ID_REPLIES[index] ?? 0xff;
  }

  private transferRead(value: number): number {
    const valid = this.sector < MEMORY_CARD_SECTOR_COUNT;
    switch (this.step) {
      case 1: this.lastAck = true; return 0x5a;
      case 2: this.lastAck = true; return 0x5d;
      case 3:
        this.sector = value << 8;
        this.lastAck = true;
        return 0;
      case 4:
        this.sector |= value;
        this.lastAck = true;
        return (this.sector >>> 8) & 0xff;
      case 5: this.lastAck = true; return 0x5c;
      case 6: this.lastAck = true; return 0x5d;
      case 7: this.lastAck = true; return valid ? (this.sector >>> 8) & 0xff : 0xff;
      case 8:
        this.lastAck = valid;
        if (!valid) this.active = false;
        return valid ? this.sector & 0xff : 0xff;
      case 137:
        this.lastAck = true;
        return this.readChecksum();
      case 138:
        this.lastAck = false;
        this.active = false;
        return 0x47;
      default:
        if (this.step >= 9 && this.step <= 136) {
          this.lastAck = true;
          return this.image[this.sector * MEMORY_CARD_SECTOR_SIZE + this.step - 9]!;
        }
        this.lastAck = false;
        this.active = false;
        return 0xff;
    }
  }

  private transferWrite(value: number): number {
    switch (this.step) {
      case 1: this.lastAck = true; return 0x5a;
      case 2: this.lastAck = true; return 0x5d;
      case 3:
        this.sector = value << 8;
        this.checksum = value;
        this.lastAck = true;
        return 0;
      case 4:
        this.sector |= value;
        this.checksum ^= value;
        this.lastAck = true;
        return this.previous;
      case 133:
        this.receivedChecksum = value;
        this.lastAck = true;
        return this.previous;
      case 134: this.lastAck = true; return 0x5c;
      case 135: this.lastAck = true; return 0x5d;
      case 136: return this.finishWrite();
      default:
        if (this.step >= 5 && this.step <= 132) {
          this.writeData[this.step - 5] = value;
          this.checksum ^= value;
          this.lastAck = true;
          return this.previous;
        }
        this.lastAck = false;
        this.active = false;
        return 0xff;
    }
  }

  private finishWrite(): number {
    this.lastAck = false;
    this.active = false;
    if (this.sector >= MEMORY_CARD_SECTOR_COUNT) return 0xff;
    if (this.receivedChecksum !== this.checksum) return 0x4e;
    this.image.set(this.writeData, this.sector * MEMORY_CARD_SECTOR_SIZE);
    this.flag &= ~0x08;
    return 0x47;
  }

  private readChecksum(): number {
    // The protocol checksum covers all 128 data bytes, including the
    // filesystem's own checksum byte at the end of a formatted frame.
    const offset = this.sector * MEMORY_CARD_SECTOR_SIZE;
    let value = (this.sector >>> 8) ^ (this.sector & 0xff);
    for (let i = 0; i < MEMORY_CARD_SECTOR_SIZE; i++) value ^= this.image[offset + i]!;
    return value;
  }
}
