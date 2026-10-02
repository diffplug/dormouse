import { useEffect, useState, useSyncExternalStore } from 'react';
import { PopupButtonRow, popupButton } from '../design';
import {
  getMouseSelectionState,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';

export function MouseOverrideBanner({ terminalId }: { terminalId: string }) {
  const visible = useSyncExternalStore(
    subscribeToMouseSelection, () => getMouseSelectionState(terminalId).override === 'temporary',
  );
  const [flashed, setFlashed] = useState<'sticky' | 'cancel' | null>(null);

  useEffect(() => {
    if (!flashed) return;
    if (!visible) {
      setFlashed(null);
      return;
    }
    const id = window.setTimeout(() => {
      if (getMouseSelectionState(terminalId).override === 'temporary') {
        setMouseOverride(terminalId, flashed === 'sticky' ? 'permanent' : 'off');
      }
      setFlashed(null);
    }, 260);
    // Observe each store transition: React can batch an override ending and
    // restarting into one visible render. The old flash belongs to neither
    // a later temporary override nor a new mouse-reporting program.
    const unsubscribe = subscribeToMouseSelection(() => {
      if (getMouseSelectionState(terminalId).override !== 'temporary') {
        window.clearTimeout(id);
        setFlashed(null);
      }
    });
    return () => { window.clearTimeout(id); unsubscribe(); };
  }, [flashed, terminalId, visible]);

  if (!visible) return null;

  return (
    <PopupButtonRow
      className="absolute right-1 top-1 z-20 whitespace-nowrap"
      onMouseDown={(e) => e.stopPropagation()}
      role="status"
    >
      <span className="px-1.5 py-0.5 text-muted">Temporary mouse override until mouse-up.</span>
      <button
        type="button"
        className={popupButton({ flashed: flashed === 'sticky' })}
        onClick={() => !flashed && setFlashed('sticky')}
      >Make sticky</button>
      <button
        type="button"
        className={popupButton({ flashed: flashed === 'cancel' })}
        onClick={() => !flashed && setFlashed('cancel')}
      >Cancel</button>
    </PopupButtonRow>
  );
}
