import type { SpuAudioSink } from "../core/spu-audio";

export type AudioGestureTarget = Window | Document | HTMLElement;

/**
 * Unlock from real pointer/keyboard gestures, without creating audio on mount.
 * The binding removes itself only after success, so autoplay denial is retryable.
 * Returned cleanup is idempotent and belongs in the owning component's effect.
 */
export function bindAudioUnlock(sink: SpuAudioSink, target: AudioGestureTarget): () => void {
  let listening = true;
  const remove = () => {
    if (!listening) return;
    listening = false;
    target.removeEventListener("pointerdown", onGesture, true);
    target.removeEventListener("keydown", onGesture, true);
  };
  const onGesture = () => {
    if (!listening) return;
    void sink.unlock().then((unlocked) => {
      if (unlocked) remove();
    }, () => {
      // Keep the gesture hooks installed; the next gesture can retry.
    });
  };
  target.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
  target.addEventListener("keydown", onGesture, { capture: true, passive: true });
  return remove;
}
