/**
 * Shared modal frame — clone of the blueprint's GtkDialog chrome
 * (title bar + OK/Cancel action area, Escape = cancel).
 * Theme: dark GTK-like (#1b1d20 / #232629 / #2a2d31 / #d6d3c8, accent #35507a).
 */
import { useEffect, type ReactNode } from "react";

export const labelClass = "text-[12px] text-[#8a8880]";
export const entryClass =
  "border border-[#2a2d31] bg-[#1b1d20] px-2 py-0.5 text-[13px] text-[#d6d3c8] focus:outline-none focus:border-[#35507a]";
export const selectClass = `${entryClass} hover:border-[#35507a]`;
export const buttonClass =
  "border border-[#2a2d31] bg-[#1b1d20] px-4 py-0.5 text-[13px] text-[#d6d3c8] hover:bg-[#35507a]";
export const frameClass = "border border-[#2a2d31] p-3";
export const frameTitleClass = "text-[12px] font-semibold text-[#d6d3c8]";

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex min-w-[440px] max-h-[85vh] max-w-[90vw] flex-col border border-[#2a2d31] bg-[#232629] text-[#d6d3c8] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#2a2d31] bg-[#1b1d20] px-3 py-1.5">
          <span className="text-[13px] font-semibold">{title}</span>
          <button className="px-2 text-[13px] hover:bg-[#35507a]" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
        <div className="flex justify-end gap-2 border-t border-[#2a2d31] px-3 py-2">
          <button className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button
            className={buttonClass}
            onClick={() => {
              onOk?.();
              onClose();
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
