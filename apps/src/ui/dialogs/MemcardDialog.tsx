import { useRef, useState } from "react";
import { MEMORY_CARD_SIZE } from "../../core/memory-card";
import { storeMemoryCard } from "../memory-card-storage";
import type { WorkerHost } from "../worker-host";
import { useApp, setConfig } from "../store";
import { Dialog, buttonClass, entryClass, frameClass, frameTitleClass } from "./Dialog";

export interface MemcardDialogProps {
  host: WorkerHost | null;
  onClose: () => void;
}

export function MemcardDialog({ host, onClose }: MemcardDialogProps) {
  const live = useApp((s) => s.config);
  const [file1, setFile1] = useState(live.Memcard1);
  const [file2, setFile2] = useState(live.Memcard2);
  const [status, setStatus] = useState("Cards load from browser-local storage when available.");
  const inputs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];

  const fileName = (slot: 0 | 1) => (slot === 0 ? file1 : file2).trim() || `slot${slot + 1}.mcr`;

  const format = async (slot: 0 | 1) => {
    if (!host) return;
    try {
      const formatted = await host.memoryCard(slot, "format");
      const bytes = formatted ?? await host.memoryCard(slot, "attach");
      if (!bytes) throw new Error(`Slot ${slot + 1} could not be formatted`);
      await storeMemoryCard(fileName(slot), new Uint8Array(bytes));
      setStatus(`Slot ${slot + 1} formatted and saved locally.`);
    } catch (error) {
      setStatus(String(error));
    }
  };

  const openFile = async (slot: 0 | 1, file: File | undefined) => {
    if (!host || !file) return;
    try {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength !== MEMORY_CARD_SIZE) throw new Error(`Memory-card image must be exactly ${MEMORY_CARD_SIZE} bytes`);
      const bytes = await host.memoryCard(slot, "import", buffer);
      if (!bytes) throw new Error(`Slot ${slot + 1} has no attached card`);
      await storeMemoryCard(fileName(slot), new Uint8Array(bytes));
      setStatus(`Loaded ${file.name} into slot ${slot + 1}.`);
    } catch (error) {
      setStatus(`Open failed: ${String(error)}`);
    }
  };

  const exportCard = async (slot: 0 | 1) => {
    if (!host) return;
    try {
      const bytes = await host.memoryCard(slot, "export");
      if (!bytes) { setStatus(`Slot ${slot + 1} has no attached card.`); return; }
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName(slot);
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported slot ${slot + 1}.`);
    } catch (error) {
      setStatus(`Export failed: ${String(error)}`);
    }
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
              <button type="button" className={buttonClass} disabled={!host} title={host ? "Import a 128 KiB card image" : "Load a game first"} onClick={() => inputs[slot]?.current?.click()}>Open</button>
              <button type="button" className={buttonClass} disabled={!host} onClick={() => void format(slot)}>Format</button>
              <button type="button" className={buttonClass} disabled={!host} onClick={() => {
                if (!host) return;
                void host.memoryCard(slot, "detach").then(() => {
                  setStatus(`Slot ${slot + 1} ejected; stored data was kept.`);
                }).catch((error) => setStatus(`Eject failed: ${String(error)}`));
              }}>Eject</button>
              <button type="button" className={buttonClass} disabled={!host} onClick={() => void exportCard(slot)}>Export</button>
            </div>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
