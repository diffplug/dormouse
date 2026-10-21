import { useEffect, useState, type ReactNode } from 'react';
import { COPY_OUTCOME_LABEL } from './design';
import { writeTextToClipboard } from '../lib/clipboard-write';
import type { CopyOutcome } from '../lib/mouse-selection';

/** How long a Copy button says it did, or could not. */
const COPY_FEEDBACK_MS = 1400;

/**
 * A button that copies `text()` — read on click, so a costly or volatile value
 * is built only when asked for — and then says, briefly, whether it did.
 */
export function CopyButton({ text, label, icon, className }: {
  text: () => string;
  label: string;
  icon?: ReactNode;
  className: string;
}) {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  return (
    <button
      type="button"
      className={className}
      onClick={() => void writeTextToClipboard(text()).then((ok) => setOutcome(ok ? 'copied' : 'failed'))}
    >
      {icon}
      {outcome ? COPY_OUTCOME_LABEL[outcome] : label}
    </button>
  );
}
