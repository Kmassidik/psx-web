import { SAVE_STATE_VERSION } from "../core/state-codec";

interface SaveStateRecord {
  key: string;
  game: string;
  slot: number;
  created: number;
  version: number;
  bytes: ArrayBuffer;
}

const DB_NAME = "psx-web.saveStates";
const STORE_NAME = "saveStates";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable; save-state slots cannot persist."));
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Unable to open save-state storage"));
  request.onblocked = () => reject(new Error("Save-state storage is blocked by another tab"));
  return promise;
}

function finish<T>(request: IDBRequest<T>, db: IDBDatabase): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => { db.close(); resolve(request.result); };
  request.onerror = () => { db.close(); reject(request.error ?? new Error("Save-state storage request failed")); };
  return promise;
}

export async function storeSaveState(game: string, slot: number, bytes: Uint8Array): Promise<void> {
  const db = await openDatabase();
  const record: SaveStateRecord = {
    key: `${game}:${slot}`,
    game,
    slot,
    created: Date.now(),
    version: SAVE_STATE_VERSION,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
  await finish(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record), db);
}

export async function loadStoredSaveState(game: string, slot: number): Promise<Uint8Array | undefined> {
  const db = await openDatabase();
  const record = await finish(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(`${game}:${slot}`), db) as SaveStateRecord | undefined;
  if (!record || record.version !== SAVE_STATE_VERSION || !(record.bytes instanceof ArrayBuffer)) return undefined;
  return new Uint8Array(record.bytes);
}
