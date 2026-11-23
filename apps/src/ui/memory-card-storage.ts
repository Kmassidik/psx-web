/** Browser-local raw memory-card images. No game/BIOS data is stored here. */
import type { Machine } from "../core/machine";
import type { JoypadPort } from "../core/joypad";

const DB_NAME = "psx-web.local";
const STORE_NAME = "memoryCards";
const VERSION = 2;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable; use Export to keep card data."));
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Unable to open memory-card storage"));
  request.onblocked = () => reject(new Error("Memory-card storage is blocked by another tab"));
  return promise;
}

function finish<T>(request: IDBRequest<T>, db: IDBDatabase): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => { db.close(); resolve(request.result); };
  request.onerror = () => { db.close(); reject(request.error ?? new Error("Memory-card storage request failed")); };
  return promise;
}

export async function loadStoredMemoryCard(name: string): Promise<Uint8Array | undefined> {
  const db = await openDatabase();
  const value = await finish(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(name), db);
  return value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
}

export async function storeMemoryCard(name: string, bytes: Uint8Array): Promise<void> {
  const db = await openDatabase();
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await finish(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(copy, name), db);
}

/** Attach formatted cards synchronously, then replace them with stored images if present. */
export function attachStoredMemoryCards(machine: Machine, names: readonly [string, string]): void {
  for (const slot of [0, 1] as const) {
    machine.joypad.attachMemoryCard(slot as JoypadPort);
    void loadStoredMemoryCard(names[slot]).then((bytes) => {
      if (bytes) machine.joypad.importMemoryCard(slot as JoypadPort, bytes);
    }).catch(() => {
      // The formatted card remains usable; Export is available without IndexedDB.
    });
  }
}
