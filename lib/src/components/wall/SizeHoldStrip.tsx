import { useState, useSyncExternalStore } from 'react';
import { PopupButtonRow, popupButton } from '../design';
import { getSizeHold, subscribeToSizeHolds } from '../../lib/size-hold-store';
import { takeBackSize } from '../../remote/burrow/take-back';

/**
 * Why a pane is not the size of its box: a remote session holds it
 * (`docs/specs/remote-api.md` → "Size authority"). Shown only while held, at
 * the pane body's bottom-right corner, where the smaller remote grid leaves
 * room (`docs/specs/layout.md` → "Pane body"). Take back ends that session.
 */
export function SizeHoldStrip({ terminalId }: { terminalId: string }) {
  const hold = useSyncExternalStore(subscribeToSizeHolds, () => getSizeHold(terminalId));
  const [taking, setTaking] = useState(false);

  if (!hold) return null;

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
      <span className="min-w-0 truncate px-1.5 py-0.5 text-muted">Sized for {hold.label}</span>
      <button
        type="button"
        className={popupButton()}
        aria-label={`Disconnect ${hold.label} and resize this pane`}
        aria-disabled={taking || undefined}
        onClick={takeBack}
      >Take back</button>
    </PopupButtonRow>
  );
}
