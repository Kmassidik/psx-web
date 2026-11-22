/**
 * MemcardDialog — clone of the blueprint's window_config_memcards
 * ("ePSXe memcards config"): frame "Select Memcards files", slot 1/2 rows
 * (memcard_file1_entry / memcard_file2_entry), Open buttons, Format/Eject.
 * OK writes Memcard1/Memcard2 via setConfig; Format/Eject are UI-only this phase.
 */
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
      <fieldset className={frameClass}>
        <legend className={frameTitleClass}>Select Memcards files</legend>
        <div className="flex flex-col gap-2">
          {(
            [
              { slot: "1", file: file1, setFile: setFile1 },
              { slot: "2", file: file2, setFile: setFile2 },
            ] as const
          ).map(({ slot, file, setFile: set }) => (
            <div key={slot} className="flex items-center gap-2">
              <span className="w-4 text-center font-bold underline">{slot}</span>
              <input
                className={`${entryClass} flex-1`}
                value={file}
                onChange={(e) => set(e.target.value)}
                aria-label={`Memcard slot ${slot} file`}
              />
              <button className={buttonClass} title="Choose memcard file">
                Open
              </button>
              <button className={buttonClass} title="Format this memcard (UI only)">
                Format
              </button>
              <button className={buttonClass} title="Eject this memcard (UI only)">
                Eject
              </button>
            </div>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
