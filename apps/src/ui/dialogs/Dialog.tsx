/** Shared modal frame with focus trapping, Escape, and focus restoration. */
import { useEffect, useId, useRef, type ReactNode } from "react";

export const labelClass = "control-label";
export const entryClass = "gtk-entry";
export const selectClass = "gtk-select";
export const buttonClass = "gtk-button";
export const frameClass = "gtk-frame";
export const frameTitleClass = "gtk-frame-title";

interface DialogProps {
  title: string;
  onClose: () => void;
  onOk?: () => void;
  okLabel?: string;
  showCancel?: boolean;
  children: ReactNode;
}

export function Dialog({ title, onClose, onOk, okLabel = "OK", showCancel = true, children }: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialogElement = dialogRef.current;
    const focusable = () => Array.from(dialogElement?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? []).filter((element) => !element.classList.contains("file-input") && element.style.display !== "none");
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialogElement?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogElement?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>(".display-area")?.focus();
    };
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialogRef} className="dialog-window" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-titlebar">
          <span id={titleId}>{title}</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-content">{children}</div>
        <div className="dialog-actions">
          {showCancel && <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>}
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              onOk?.();
              onClose();
            }}
          >{okLabel}</button>
        </div>
      </section>
    </div>
  );
}
