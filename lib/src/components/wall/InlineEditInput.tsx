import { useCallback, useRef, useState } from 'react';

interface InlineEditInputProps {
  /** Seed value, read once at mount. Later changes are ignored — the field
   *  belongs to the user from the moment it opens. */
  initialValue: string;
  className: string;
  /** Enter, and blur when `blurAction` is `'submit'`. Gets the element so the
   *  caller can anchor a popover under the field it came from. */
  onSubmit: (value: string, el: HTMLInputElement) => void;
  /** Escape, and blur when `blurAction` is `'cancel'`. */
  onCancel: () => void;
  /** What losing focus means: pane titles commit (`'submit'`), the URL editor
   *  discards like a browser omnibox (`'cancel'`). */
  blurAction: 'submit' | 'cancel';
  [key: `data-${string}`]: string;
}

/**
 * The inline editor behind pane rename and the browser URL bar.
 *
 * It owns the draft in its own state and mounts pre-selected exactly once. Both
 * halves matter: pane headers re-render constantly (activity, terminal state,
 * agent-browser chrome), and the field must survive that untouched. An
 * uncontrolled `<input defaultValue>` with an inline `ref={(el) => el?.select()}`
 * does not — the arrow is a new function identity every render, so React
 * detaches and reattaches the ref and re-selects the text mid-edit, making the
 * next keystroke replace everything typed so far (`docs/specs/layout.md` →
 * "Inline rename").
 *
 * Mounting is the reset: callers render this only while editing, so each
 * editing session gets a fresh draft seeded from `initialValue`.
 */
export function InlineEditInput({
  initialValue,
  className,
  onSubmit,
  onCancel,
  blurAction,
  ...dataAttrs
}: InlineEditInputProps) {
  const [draft, setDraft] = useState(initialValue);
  // Stable identity ⇒ React attaches it once, on mount, and never re-runs it.
  const selectOnMount = useCallback((el: HTMLInputElement | null) => { el?.select(); }, []);
  // Enter/Escape already decided the outcome; the blur that follows the
  // resulting unmount must not submit a second time (or undo an Escape).
  const settledRef = useRef(false);

  return (
    <input
      {...dataAttrs}
      className={className}
      value={draft}
      autoFocus
      ref={selectOnMount}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          settledRef.current = true;
          onSubmit(draft, e.currentTarget);
        } else if (e.key === 'Escape') {
          settledRef.current = true;
          onCancel();
        }
        e.stopPropagation();
      }}
      onBlur={(e) => {
        if (settledRef.current) return;
        settledRef.current = true;
        if (blurAction === 'submit') onSubmit(draft, e.currentTarget);
        else onCancel();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
