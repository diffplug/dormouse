import { subscribeWindowFocus } from './window-focus';

/** Cancel a pointer drag on Escape or a real window blur. Returns the unsubscribe.
 *  Escape is caught in the capture phase: a focused terminal stops the keydown before
 *  it bubbles to the window. */
export function subscribeDragCancel(onCancel: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  window.addEventListener('keydown', onKey, true);
  const unsubscribeFocus = subscribeWindowFocus((focused) => {
    if (!focused) onCancel();
  });
  return () => {
    window.removeEventListener('keydown', onKey, true);
    unsubscribeFocus();
  };
}
