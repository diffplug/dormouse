import { useContext } from 'react';
import { ArrowLineDownIcon, ArrowsInIcon, ArrowsOutIcon, XIcon } from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { paneZoomButtonClass } from '../design';
import { WallActionsContext } from './wall-context';

const ACTION_BUTTON_CLASS = 'flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10';

/** Whoever renders minimize + kill watches them for focus, because a header
 *  that relocates the pair should take focus with them. */
export type FocusHandlers = { onFocus?: () => void; onBlur?: () => void };

/**
 * Minimize + kill. One component for both headers so the labels and their
 * shortcut hints (`docs/specs/shortcuts.md`) are written once, and so the
 * browser header can render the pair on its own inside the popover.
 * `beforeAct` is that header's popover dismissal; the terminal passes none.
 */
export function MinimizeKillButtons({ surfaceId, beforeAct, onFocus, onBlur }: {
  surfaceId: string;
  beforeAct?: () => void;
} & FocusHandlers) {
  const actions = useContext(WallActionsContext);
  return (
    <div className="flex shrink-0 items-center gap-0.5" onFocus={onFocus} onBlur={onBlur}>
      <HeaderActionButton
        className={ACTION_BUTTON_CLASS}
        onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onMinimize(surfaceId); }}
        ariaLabel="Minimize"
        tooltip="Minimize [m] or [d]"
      ><ArrowLineDownIcon size={14} /></HeaderActionButton>
      <HeaderActionButton
        className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
        onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onKill(surfaceId); }}
        ariaLabel="Kill"
        tooltip="Kill [k] or [x]"
      ><XIcon size={14} /></HeaderActionButton>
    </div>
  );
}

/**
 * The pane-action group both headers end with: zoom, then minimize + kill while
 * they fit. It sits last so nothing fixed-width is to its right to push it off
 * the header. `docs/specs/layout.md` → "Pane header responsive sizing" owns
 * when `showMinimizeKill` goes false and where that pair ends up.
 */
export function PaneActionGroup({
  surfaceId, zoomed, activeHeader, showMinimizeKill, className = 'ml-1', beforeAct, minimizeKillFocus,
}: {
  surfaceId: string;
  zoomed: boolean;
  activeHeader: boolean;
  showMinimizeKill: boolean;
  className?: string;
  beforeAct?: () => void;
  minimizeKillFocus?: FocusHandlers;
}) {
  const actions = useContext(WallActionsContext);
  return (
    <div className={`${className} flex shrink-0 items-center gap-0.5`}>
      <HeaderActionButton
        className={paneZoomButtonClass(zoomed, activeHeader)}
        onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onZoom(surfaceId); }}
        ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
        tooltip={zoomed ? 'Unzoom' : 'Zoom [z]'}
      >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
      {showMinimizeKill && <MinimizeKillButtons surfaceId={surfaceId} beforeAct={beforeAct} {...minimizeKillFocus} />}
    </div>
  );
}
