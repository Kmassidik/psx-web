/** Memory-card file-name preferences; card I/O is not connected to Machine. */
import { useState } from "react";
import { useApp, setConfig } from "../store";
import { Dialog, buttonClass, entryClass, frameClass, frameTitleClass } from "./Dialog";

export interface MemcardDialogProps {
  onClose: () => void;
}

/** Clone of window_config_memcards. */
export function MemcardDialog({ onClose }: MemcardDialogProps) {
  const live = useApp((s) => s.config);
  const [file1, setFile1] = useState(live.Memcard1);
  const [file2, setFile2] = useState(live.Memcard2);

  return (
    <Dialog title="ePSXe memcards config" onClose={onClose} onOk={() => setConfig({ Memcard1: file1, Memcard2: file2 })}>
      <p id="memcard-note" className="dialog-note">
        File names are saved as preferences only. Card data is not loaded or attached to the running machine.
      </p>
      <fieldset className={frameClass} aria-describedby="memcard-note">
        <legend className={frameTitleClass}>Select Memcards files</legend>
        <div className="memcard-grid">
          {(
            [
              { slot: "1", file: file1, setFile: setFile1 },
              { slot: "2", file: file2, setFile: setFile2 },
            ] as const
          ).map(({ slot, file, setFile: set }) => (
            <div key={slot} className="memcard-row">
              <span className="memcard-number">{slot}</span>
              <input
                className={entryClass}
                value={file}
                onChange={(e) => set(e.target.value)}
                aria-label={`Memcard slot ${slot} file`}
                maxLength={1024}
                aria-describedby="memcard-note"
              />
              <button type="button" className={buttonClass} disabled title="Memory-card file loading is not connected to the emulator.">Open</button>
              <button type="button" className={buttonClass} disabled title="Memory-card formatting requires card storage support.">Format</button>
              <button type="button" className={buttonClass} disabled title="No memory card is attached to the running machine.">Eject</button>
            </div>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
