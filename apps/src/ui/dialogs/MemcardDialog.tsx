import { useEffect, useRef, useState } from "react";
import type { Machine } from "../../core/machine";
import { createFormattedMemoryCard, MEMORY_CARD_SIZE } from "../../core/memory-card";
import { loadStoredMemoryCard, storeMemoryCard } from "../memory-card-storage";
import { useApp, setConfig } from "../store";
import { Dialog, buttonClass, entryClass, frameClass, frameTitleClass } from "./Dialog";

export interface MemcardDialogProps {
  machine: Machine | null;
  onClose: () => void;
}

export function MemcardDialog({ machine, onClose }: MemcardDialogProps) {
  const live = useApp((s) => s.config);
  const [file1, setFile1] = useState(live.Memcard1);
  const [file2, setFile2] = useState(live.Memcard2);
  const [status, setStatus] = useState("Cards load from browser-local storage when available.");
  const inputs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];

  useEffect(() => {
    if (!machine) return;
    for (const [slot, name] of [[0, file1], [1, file2]] as const) {
      void loadStoredMemoryCard(name).then((bytes) => {
        if (bytes) machine.joypad.importMemoryCard(slot, bytes);
        else machine.joypad.attachMemoryCard(slot);
      }).catch((error) => setStatus(`Slot ${slot + 1}: ${String(error)}`));
    }
  }, [machine]); // Initial names are preferences; editing them does not replace attached cards.

  const fileName = (slot: 0 | 1) => (slot === 0 ? file1 : file2).trim() || `slot${slot + 1}.mcr`;
  const persist = async (slot: 0 | 1) => {
    if (!machine) return;
    const bytes = machine.joypad.exportMemoryCard(slot);
    if (!bytes) throw new Error(`Slot ${slot + 1} has no attached card`);
    await storeMemoryCard(fileName(slot), bytes);
  };

  const format = (slot: 0 | 1) => {
    if (!machine) return;
    try {
      machine.joypad.importMemoryCard(slot, createFormattedMemoryCard());
      void persist(slot).then(() => setStatus(`Slot ${slot + 1} formatted and saved locally.`)).catch((error) => setStatus(String(error)));
    } catch (error) {
      setStatus(String(error));
    }
  };

  const openFile = async (slot: 0 | 1, file: File | undefined) => {
    if (!machine || !file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== MEMORY_CARD_SIZE) throw new Error(`Memory-card image must be exactly ${MEMORY_CARD_SIZE} bytes`);
      machine.joypad.importMemoryCard(slot, bytes);
      await storeMemoryCard(fileName(slot), bytes);
      setStatus(`Loaded ${file.name} into slot ${slot + 1}.`);
    } catch (error) {
      setStatus(`Open failed: ${String(error)}`);
    }
  };

  const exportCard = (slot: 0 | 1) => {
    if (!machine) return;
    const bytes = machine.joypad.exportMemoryCard(slot);
    if (!bytes) { setStatus(`Slot ${slot + 1} has no attached card.`); return; }
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName(slot);
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported slot ${slot + 1}.`);
  };

  return (
    <Dialog title="ePSXe memcards config" onClose={onClose} onOk={() => setConfig({ Memcard1: file1, Memcard2: file2 })}>
      <p id="memcard-note" className="dialog-note" role="status">{status}</p>
      <fieldset className={frameClass} aria-describedby="memcard-note">
        <legend className={frameTitleClass}>Select Memcards files</legend>
        <div className="memcard-grid">
          {([0, 1] as const).map((slot) => (
            <div key={slot} className="memcard-row">
              <span className="memcard-number">{slot + 1}</span>
              <input
                className={entryClass}
                value={slot === 0 ? file1 : file2}
                onChange={(event) => slot === 0 ? setFile1(event.target.value) : setFile2(event.target.value)}
                aria-label={`Memcard slot ${slot + 1} file`}
                maxLength={1024}
              />
              <input
                ref={inputs[slot]}
                type="file"
                accept=".mcr,.mc,.bin"
                hidden
                onChange={(event) => {
                  void openFile(slot, event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
              <button type="button" className={buttonClass} disabled={!machine} title={machine ? "Import a 128 KiB card image" : "Load a game first"} onClick={() => inputs[slot]?.current?.click()}>Open</button>
              <button type="button" className={buttonClass} disabled={!machine} onClick={() => format(slot)}>Format</button>
              <button type="button" className={buttonClass} disabled={!machine} onClick={() => { machine?.joypad.detachMemoryCard(slot); setStatus(`Slot ${slot + 1} ejected; stored data was kept.`); }}>Eject</button>
              <button type="button" className={buttonClass} disabled={!machine} onClick={() => exportCard(slot)}>Export</button>
            </div>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
