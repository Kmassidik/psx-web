/**
 * Minimal kernel-call surface for BIOS-free PS-EXE boots (A/B/C-call stubs).
 * Stateful services live per Machine; no heap or event state is shared between
 * emulated consoles. Unimplemented calls retain conservative stub returns.
 */
import type { Cpu } from "./cpu";
import { parsePsExe } from "./loader/psexe";
import { readIsoFile, type SectorProvider } from "./loader/iso9660";

interface InterruptHandler {
  priority: number;
  struc: number;
  first: number;
}

interface BiosEvent {
  handle: number;
  class: number;
  spec: number;
  mode: number;
  func: number;
  enabled: boolean;
  ready: boolean;
}

export class BiosKernel {
  readonly state = { heapNext: 0, kernelNext: 0x8000_4000, nextEvent: 0xf100_0000 | 0 };
  private readonly events: BiosEvent[] = [];
  private readonly interruptHandlers: InterruptHandler[] = [];
  private readonly pendingCallbacks: number[] = [];
  private padDest = 0;
  private customExit = 0;
  private sectorProvider?: SectorProvider;

  setSectorProvider(provider: SectorProvider): void {
    this.sectorProvider = provider;
  }

  constructor(
    private readonly cpu: Cpu,
    private readonly gpu: { writeGP0(w: number): void },
    private readonly pads: { pad1: number; pad2: number },
  ) {
    this.installTable(0xb0, 0x1000, 0x1400);
    this.installTable(0xc0, 0x2000, 0x2400);
    // BIOS-internal CDROM events: acknowledge, complete, data ready, end, error.
    for (const spec of [0x10, 0x20, 0x40, 0x80, 0x8000]) {
      this.events.push({
        handle: this.state.nextEvent++,
        class: 0xf000_0003 | 0,
        spec,
        mode: 0x2000,
        func: 0,
        enabled: true,
        ready: false,
      });
    }
  }

  private installTable(vector: number, table: number, stubs: number): void {
    for (let fn = 0; fn < 256; fn++) {
      const stub = stubs + fn * 12;
      this.cpu.mem.store32(table + fn * 4, 0x8000_0000 | stub);
      this.cpu.mem.store32(stub, 0x2409_0000 | fn); // ADDIU t1, zero, fn
      this.cpu.mem.store32(stub + 4, 0x0800_0000 | (vector >>> 2)); // J vector
      this.cpu.mem.store32(stub + 8, 0); // delay slot
    }
  }

  call(table: number, fn: number): number {
    if (table === 0xa0) return this.aCall(fn);
    if (table === 0xb0) return this.bCall(fn);
    return this.cCall(fn);
  }

  interruptHandler(): number {
    return this.interruptHandlers[0]?.first ?? 0;
  }

  exceptionHook(): number {
    return this.customExit === 0 ? 0 : this.cpu.mem.load32(this.customExit);
  }

  updatePads(): number {
    const buttons = ((this.pads.pad2 << 16) | this.pads.pad1) | 0;
    if (this.padDest !== 0) this.cpu.mem.store32(this.padDest, buttons);
    return buttons;
  }

  deliver(eventClass: number, spec: number): void {
    eventClass |= 0;
    spec |= 0;
    for (const event of this.events) {
      if (!event.enabled || event.class !== eventClass || event.spec !== spec) continue;
      if (event.mode === 0x2000) event.ready = true;
      else if (event.mode === 0x1000 && event.func !== 0) this.pendingCallbacks.push(event.func);
    }
  }

  takeEventCallbacks(): number[] {
    return this.pendingCallbacks.splice(0);
  }

  private cCall(fn: number): number {
    if (fn === 0x02) {
      this.interruptHandlers.unshift({
        priority: this.cpu.r[4]!,
        struc: this.cpu.r[5]!,
        first: this.cpu.mem.load32(this.cpu.r[5]! + 8),
      });
      return 0;
    }
    if (fn === 0x03) {
      const index = this.interruptHandlers.findIndex((handler) => handler.struc === this.cpu.r[5]!);
      if (index < 0) return 0;
      this.interruptHandlers.splice(index, 1);
      return this.cpu.r[5]!;
    }
    return 0;
  }

  private readCString(address: number): string {
    let result = "";
    for (let i = 0; i < 260; i++) {
      const byte = this.cpu.mem.load8(address + i);
      if (byte === 0) break;
      result += String.fromCharCode(byte);
    }
    return result;
  }

  private loadAndExecute(): number {
    if (!this.sectorProvider) return 0;
    const filename = this.readCString(this.cpu.r[4]!);
    const bytes = readIsoFile(this.sectorProvider, filename);
    if (!bytes) return 0;
    const exe = parsePsExe(bytes);
    const stack = (this.cpu.r[5]! + this.cpu.r[6]!) | 0;
    const gp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x14, true);
    this.cpu.mem.ram.set(exe.data, exe.t_addr);
    this.cpu.reset(exe.pc0);
    this.cpu.r[28] = gp | 0;
    this.cpu.r[29] = stack;
    this.cpu.r[30] = stack;
    this.cpu.r[5] = -1;
    // Enter via J so the new program inherits the BIOS exit stub in RA.
    this.cpu.mem.store32(0x108, (0x02 << 26) | ((exe.pc0 >>> 2) & 0x03ff_ffff));
    this.cpu.mem.store32(0x10c, 0);
    this.cpu.r[31] = 0x8000_0108;
    return 1;
  }

  private aCall(fn: number): number {
    switch (fn) {
      case 0x33: { // malloc(size)
        const size = this.cpu.r[4]!;
        if (this.state.heapNext === 0 || size <= 0) return 0;
        const result = this.state.heapNext;
        this.state.heapNext = (result + size + 7) & ~7;
        return result;
      }
      case 0x39: // InitHeap(addr, size)
        this.state.heapNext = this.cpu.r[4]!;
        return 0;
      case 0x49: // GPU_cw(gp0cmd)
        this.gpu.writeGP0(this.cpu.r[4]!);
        return 0;
      case 0x51: // LoadAndExecute(filename, stackbase, stackoffset)
        return this.loadAndExecute();
      case 0x32: // FileOpen — full filesystem delivery is not implemented
        return 0xdead_0001;
      default:
        return 1;
    }
  }

  private bCall(fn: number): number {
    const handle = this.cpu.r[4]!;
    switch (fn) {
      case 0x00: { // alloc_kernel_memory(size)
        const size = handle;
        if (size <= 0) return 0;
        const result = this.state.kernelNext;
        this.state.kernelNext = (result + size + 7) & ~7;
        return result;
      }
      case 0x07: // DeliverEvent(class, spec)
        this.deliver(handle, this.cpu.r[5]!);
        return 0;
      case 0x08: { // OpenEvent(class, spec, mode, func)
        const eventHandle = this.state.nextEvent++;
        this.events.push({
          handle: eventHandle,
          class: handle,
          spec: this.cpu.r[5]!,
          mode: this.cpu.r[6]!,
          func: this.cpu.r[7]!,
          enabled: false,
          ready: false,
        });
        return eventHandle;
      }
      case 0x18: // SetDefaultExitFromException
        this.customExit = 0;
        return 0;
      case 0x19: // SetCustomExitFromException(addr)
        this.customExit = this.cpu.r[4]!;
        return 0;
      case 0x15: // OutdatedPadInitAndStart(type, button_dest, ...)
        this.padDest = this.cpu.r[5]!;
        this.updatePads();
        return 2;
      case 0x16: // OutdatedPadGetButtons: pad2 high, pad1 low, active-low
        return this.updatePads();
      case 0x09: { // CloseEvent(event)
        const index = this.events.findIndex((event) => event.handle === handle);
        if (index >= 0) this.events.splice(index, 1);
        return 1;
      }
      case 0x0a: // WaitEvent — HLE cannot block the host; report current state
      case 0x0b: { // TestEvent(event)
        const event = this.events.find((candidate) => candidate.handle === handle);
        if (!event?.enabled || !event.ready || event.mode !== 0x2000) return 0;
        event.ready = false;
        return 1;
      }
      case 0x0c: // EnableEvent(event)
      case 0x0d: { // DisableEvent(event)
        const event = this.events.find((candidate) => candidate.handle === handle);
        if (event) event.enabled = fn === 0x0c;
        return 1;
      }
      case 0x32: // FileOpen — full filesystem delivery is not implemented
        return 0xdead_0001;
      case 0x56: // GetC0Table
        return 0x8000_2000;
      case 0x57: // GetB0Table
        return 0x8000_1000;
      default:
        return 0;
    }
  }
}
