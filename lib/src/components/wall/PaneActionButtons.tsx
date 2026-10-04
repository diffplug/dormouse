import { useContext } from 'react';
import { ArrowLineDownIcon, ArrowsInIcon, ArrowsOutIcon, LinkBreakIcon, SplitHorizontalIcon, SplitVerticalIcon, TerminalIcon, XIcon } from '@phosphor-icons/react';
import { TOOL_DIRTY_LABEL, ToolDirtyIndicator } from '../ToolDirtyIndicator';
import { HeaderActionButton } from '../HeaderActionButton';
import { chromeButton, paneZoomButtonClass } from '../design';
import { TerminalContextContext, WallActionsContext } from './wall-context';

/** Whoever renders minimize + kill watches them for focus, because a header
 *  that relocates the pair should take focus with them. */
export type FocusHandlers = { onFocus?: () => void; onBlur?: () => void };

/**
 * Minimize + kill. One component for both headers so the labels and their
 * shortcut hints (`docs/specs/shortcuts.md`) are written once, and so the
 * browser header can render the pair on its own inside the popover.
 * `beforeAct` is that header's popover dismissal; the terminal passes none.
 * `breakable` puts a Tool's Break between them (`docs/specs/dor-tool.md` ->
 * Run end), Kill staying Kill.
 */
export function MinimizeKillButtons({ surfaceId, dirty = false, breakable = false, beforeAct, onFocus, onBlur }: {
  surfaceId: string;
  dirty?: boolean;
  breakable?: boolean;
  beforeAct?: () => void;
} & FocusHandlers) {
  const actions = useContext(WallActionsContext);
  return (
    <div className="flex shrink-0 items-center gap-0.5" onFocus={onFocus} onBlur={onBlur}>
      <HeaderActionButton
        className={chromeButton()}
        onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onMinimize(surfaceId); }}
        ariaLabel="Minimize"
        tooltip="Minimize [m] or [d]"
      ><ArrowLineDownIcon size={14} /></HeaderActionButton>
      {breakable && actions.onBreakTool && (
        <HeaderActionButton
          className={chromeButton()}
          onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onBreakTool?.(surfaceId); }}
          ariaLabel="Break"
          tooltip="Break into a plain terminal and a browser pane"
        ><LinkBreakIcon size={14} /></HeaderActionButton>
      )}
      <HeaderActionButton
        className="group/kill flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
        onClick={(e) => { e.stopPropagation(); beforeAct?.(); actions.onKill(surfaceId); }}
        ariaLabel="Kill"
        ariaDescription={dirty ? TOOL_DIRTY_LABEL : undefined}
        tooltip={`${dirty ? `${TOOL_DIRTY_LABEL} · ` : ''}Kill [k] or [x]`}
      >
        <ToolDirtyIndicator dirty={dirty} className="group-hover/kill:hidden group-focus-visible/kill:hidden" />
        <XIcon size={14} className={dirty ? 'hidden group-hover/kill:block group-focus-visible/kill:block' : undefined} />
      </HeaderActionButton>
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
  surfaceId, zoomed, activeHeader, showMinimizeKill, dirty = false, breakable = false, className = 'ml-1', beforeAct, minimizeKillFocus,
}: {
  surfaceId: string;
  dirty?: boolean;
  breakable?: boolean;
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
      {showMinimizeKill && <MinimizeKillButtons surfaceId={surfaceId} dirty={dirty} breakable={breakable} beforeAct={beforeAct} {...minimizeKillFocus} />}
    </div>
  );
}

/** Split left/right and top/bottom, which every header shows only at its
 *  widest tier (`docs/specs/layout.md` -> "Pane header responsive sizing"). */
export function SplitButtons({ surfaceId }: { surfaceId: string }) {
  const actions = useContext(WallActionsContext);
  return (
    <div className="ml-1 flex shrink-0 items-center gap-0.5">
      <HeaderActionButton
        className={chromeButton()}
        onClick={(e) => { e.stopPropagation(); actions.onSplitH(surfaceId); }}
        ariaLabel="Split left/right"
        tooltip="Split left/right [|] or [%]"
      ><SplitHorizontalIcon size={14} /></HeaderActionButton>
      <HeaderActionButton
        className={chromeButton()}
        onClick={(e) => { e.stopPropagation(); actions.onSplitV(surfaceId); }}
        ariaLabel="Split top/bottom"
        tooltip={'Split top/bottom [-] or ["]'}
      ><SplitVerticalIcon size={14} /></HeaderActionButton>
    </div>
  );
}

/** The width a 20px header control, such as the one below, adds to a header:
 *  itself and the header's 6px gap. */
export const HEADER_CONTROL_SLOT_PX = 26;

/** Toggles a Tool's Terminal Context, which shows its primary terminal
 *  (`docs/specs/terminal-context.md` -> Tool context), from under the button. */
export function TerminalContextButton({ surfaceId }: { surfaceId: string }) {
  const context = useContext(TerminalContextContext);
  const open = context.id === surfaceId;
  return (
    <button type="button" className={`${chromeButton()} shrink-0`}
      title="Terminal context" aria-label="Terminal context" aria-expanded={open}
      onClick={event => {
        event.stopPropagation();
        if (open) context.close();
        else { const rect = event.currentTarget.getBoundingClientRect(); context.open(surfaceId, { origin: { x: rect.left, y: rect.bottom } }); }
      }}><TerminalIcon size={14} /></button>
  );
}
