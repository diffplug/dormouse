import { useState, useSyncExternalStore } from 'react';
import { PopupButtonRow, popupButton } from '../design';
import { getSizeHolds, subscribeToSizeHolds } from '../../lib/size-hold-store';
import { takeBackSize } from '../../remote/burrow/take-back';

/**
 * Why a pane is not the size of its box: remote sessions hold it
 * (`docs/specs/remote-api.md` → "Size authority"). Shown only while held, at
 * the pane body's bottom-right corner, where the smaller remote grid leaves
 * room (`docs/specs/layout.md` → "Pane body"). It names the newest holder —
 * whose size the pane stands at — and counts the rest; Take back ends them all.
 */
export function SizeHoldStrip({ terminalId }: { terminalId: string }) {
  const holds = useSyncExternalStore(subscribeToSizeHolds, () => getSizeHolds(terminalId));
  const [taking, setTaking] = useState(false);

  const newest = holds[holds.length - 1];
  if (!newest) return null;
  const others = holds.length - 1;

  const takeBack = () => {
    if (taking) return;
    setTaking(true);
    void takeBackSize(terminalId).finally(() => setTaking(false));
  };

  return (
    <PopupButtonRow
      className="absolute bottom-1 right-1 z-20 max-w-[calc(100%-0.5rem)] whitespace-nowrap"
      onMouseDown={(e) => e.stopPropagation()}
      role="status"
    >
      <span className="min-w-0 truncate px-1.5 py-0.5 text-muted">
        Sized for {newest.label}{others > 0 ? ` +${others}` : ''}
      </span>
      <button
        type="button"
        className={popupButton()}
        aria-label={`Disconnect ${holds.map((hold) => hold.label).join(', ')} and resize this pane`}
        aria-disabled={taking || undefined}
        onClick={takeBack}
      >Take back</button>
    </PopupButtonRow>
  );
}
