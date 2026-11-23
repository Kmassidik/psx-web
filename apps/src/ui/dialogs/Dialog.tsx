/**
 * Shared modal frame — clone of the blueprint's GtkDialog chrome
 * (title bar + OK/Cancel action area, Escape = cancel).
 */
import { useEffect, type ReactNode } from "react";

export const labelClass = "control-label";
export const entryClass = "gtk-entry";
export const selectClass = "gtk-select";
export const buttonClass = "gtk-button";
export const frameClass = "gtk-frame";
export const frameTitleClass = "gtk-frame-title";

interface DialogProps {
  title: string;
  onClose: () => void;
  /** Called before close when the user accepts (OK). */
  onOk?: () => void;
  children: ReactNode;
}

export function Dialog({ title, onClose, onOk, children }: DialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop">
      <section className="dialog-window" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-titlebar">
          <span>{title}</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-content">{children}</div>
        <div className="dialog-actions">
          <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              onOk?.();
              onClose();
            }}
          >OK</button>
        </div>
      </section>
    </div>
  );
}
