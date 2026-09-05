import { useCallback, useEffect, useRef, useState, useMemo, useLayoutEffect, useContext, useSyncExternalStore, type ReactNode } from 'react';
import {
  BellRingingIcon,
  BellSlashIcon,
  CaretLeftIcon,
  CaretRightIcon,
  SlidersHorizontalIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from '@phosphor-icons/react';
import { SettingsDialog } from './SettingsDialog';
import { Door } from './Door';
import { DoorNotepadPopover } from './DoorNotepadPopover';
import { DialogKeyboardContext, DoorElementsContext } from './wall/wall-context';
import type { DoorChip, DooredItem } from './wall/wall-types';
import { hasTerminal } from 'dor/commands/types';
import { IS_MAC } from '../lib/platform';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import {
  getNotepadSnapshot,
  setOpenNotepadId,
  subscribeToNotepad,
} from '../lib/notepad/notepad-store';
import { revealNoteSource } from '../lib/notepad/pin';
import {
  buildAppTitleResolver,
  DEFAULT_ACTIVITY_STATE,
  getActivitySnapshot,
  getAlertSettings,
  getAlertSpeechSnapshot,
  getTerminalPaneStateSnapshot,
  subscribeToActivity,
  subscribeToAlertSettings,
  subscribeToAlertSpeech,
  subscribeToTerminalPaneState,
} from '../lib/terminal-registry';
import { createTerminalPaneState, deriveSurfaceLabel } from '../lib/terminal-state';

/** Shared look for every baseboard-level button (DESIGN.md -> Navigation). */
const BASEBOARD_BUTTON_CLASS =
  'flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded px-1.5 pb-px text-sm font-medium font-mono text-muted transition-colors hover:bg-surface-raised hover:text-foreground';

export interface BaseboardProps {
  items: DoorChip[];
  onReattach: (item: DooredItem) => void;
  notice?: ReactNode;
  /** A visible Door received a primary-button press (drag-out): the item + the press
   *  point, so the Wall can start LathHost's threshold-gated external drag. Absent
   *  (constrained embedders without a Wall) leaves Doors click-only. */
  onDoorDragStart?: (item: DooredItem, press: { clientX: number; clientY: number }) => void;
}
export function Baseboard({ items, onReattach, notice, onDoorDragStart }: BaseboardProps) {
  const { elements: doorElements, bumpVersion } = useContext(DoorElementsContext);
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const speechStates = useSyncExternalStore(subscribeToAlertSpeech, getAlertSpeechSnapshot);
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  // One subscription for every Door's note count, like the activity one above.
  // A host with no notepad reports zero everywhere, so the Door stays a pure
  // props component and never asks the platform anything.
  const notepadNotes = useSyncExternalStore(subscribeToNotepad, getNotepadSnapshot);
  const notepadAvailable = hasNotepadArchive();
  const appTitleForPane = useMemo(
    () => buildAppTitleResolver(terminalStates, activityStates),
    [terminalStates, activityStates],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  // Measured door widths, held as *state* rather than a ref. The fitting budget
  // below runs during render, so a re-measure that only wrote a ref would leave
  // the visible row fitted against the previous widths with nothing scheduled to
  // correct it — and a SPEAKING/SPOKEN Door is materially wider than its resting
  // form, so that stale frame overflows the baseboard and persists. The equality
  // guard on write keeps this to one extra render on a real width change, rather
  // than one on every activity notification.
  const [doorWidths, setDoorWidths] = useState<number[]>([]);
  const arrowMeasureEl = useRef<HTMLButtonElement>(null);
  const rightClusterEl = useRef<HTMLDivElement>(null);
  const [rightClusterWidth, setRightClusterWidth] = useState(0);
  const layoutMetrics = useRef({ doorGap: 0, arrowWidth: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which Door's notepad popover is open, with the rect it was anchored on. The
  // rect is kept rather than re-read: a pin reattaches the Surface, so the Door
  // may be gone by the time the popover reopens to report a dead source.
  const [doorNotepad, setDoorNotepad] = useState<
    { id: string; rect: DOMRect; unavailableNoteId: string | null } | null
  >(null);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);

  // Suppress command-mode key dispatch while the Settings dialog owns the
  // keyboard, so typing a timeout doesn't trigger pane shortcuts.
  useEffect(() => {
    setDialogKeyboardActive(settingsOpen);
    return () => setDialogKeyboardActive(false);
  }, [settingsOpen, setDialogKeyboardActive]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The right cluster's width is never available to doors, so the fitting budget
  // below subtracts it. Observed rather than measured on render: the host's
  // `notice` element is referentially stable, so it appears and disappears
  // through its own internal state without ever re-rendering this component.
  useLayoutEffect(() => {
    const el = rightClusterEl.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setRightClusterWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const measureEl = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = measureEl.current;
    if (!el) return;
    const widths: number[] = [];
    for (let i = 0; i < el.children.length; i++) {
      widths.push((el.children[i] as HTMLElement).offsetWidth);
    }
    setDoorWidths(prev =>
      prev.length === widths.length && prev.every((w, i) => w === widths[i]) ? prev : widths,
    );

    // Measure layout metrics from DOM to stay in sync with CSS classes
    const container = containerRef.current;
    if (container) {
      layoutMetrics.current.doorGap = parseFloat(getComputedStyle(container).gap) || 0;
    }
    if (arrowMeasureEl.current) {
      layoutMetrics.current.arrowWidth = arrowMeasureEl.current.offsetWidth;
    }
  }, [items, activityStates, speechStates, terminalStates, notepadNotes]);

  // Reset startIndex when the set of door items changes (not just count)
  const itemKey = useMemo(() => items.map(i => i.id).join('\0'), [items]);
  useLayoutEffect(() => {
    setStartIndex(0);
  }, [itemKey]);

  const shortcutHint = IS_MAC
    ? 'LCmd → RCmd to enter command mode'
    : 'LShift → RShift to enter command mode';
  const showHint = items.length === 0 && containerWidth > 350;

  // contentRect.width already excludes container padding
  const availableWidth = containerWidth;
  let visibleCount = 0;
  let usedWidth = 0;

  if (items.length > 0) {
    const widths = doorWidths;
    const { doorGap, arrowWidth } = layoutMetrics.current;
    const hasLeftOverflow = startIndex > 0;
    const budget = availableWidth
      - (hasLeftOverflow ? arrowWidth : 0)
      - (rightClusterWidth + doorGap);

    for (let i = startIndex; i < items.length; i++) {
      const doorW = (widths[i] || 100) + (visibleCount > 0 ? doorGap : 0);
      const needsRightArrow = i + 1 < items.length;
      const rightReserve = needsRightArrow ? arrowWidth : 0;

      if (usedWidth + doorW + rightReserve > budget) break;
      usedWidth += doorW;
      visibleCount++;
    }

    // Ensure at least one door is visible
    if (visibleCount === 0 && items.length > 0) visibleCount = 1;
  }

  const endIndex = startIndex + visibleCount;
  const hiddenLeft = startIndex;
  const hiddenRight = items.length - endIndex;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const visibleDoors = new Map<string, HTMLElement>();
    for (const item of items.slice(startIndex, endIndex)) {
      const el = container.querySelector<HTMLElement>(`[data-door-id="${item.id}"]`);
      if (el) visibleDoors.set(item.id, el);
    }

    let changed = false;
    if (doorElements.size !== visibleDoors.size) {
      changed = true;
    } else {
      for (const [id, el] of visibleDoors) {
        if (doorElements.get(id) !== el) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;

    doorElements.clear();
    for (const [id, el] of visibleDoors) {
      doorElements.set(id, el);
    }
    bumpVersion();
  }, [items, startIndex, endIndex, doorElements, bumpVersion]);

  // Every per-item Door prop is projected once, here: the hidden pass exists to
  // measure the visible one, so the two must draw a Door identically or the
  // widths it feeds go stale.
  const doorProps = (item: DoorChip) => {
    const activity = activityStates.get(item.id) ?? DEFAULT_ACTIVITY_STATE;
    return {
      // Only a terminal-backed Surface has shell state to derive a label from;
      // anything else keeps the store-backed title it already carries.
      title: hasTerminal(item.kind)
        ? deriveSurfaceLabel(terminalStates.get(item.id) ?? createTerminalPaneState(), appTitleForPane, item.title)
        : item.title,
      browserDisplay: item.browserDisplay,
      status: activity.status,
      ringSeq: activity.ringSeq,
      todo: activity.todo,
      speechState: speechStates.get(item.id),
      noteCount: notepadAvailable ? (notepadNotes.get(item.id)?.length ?? 0) : 0,
    };
  };

  // Opening a Door's notepad closes the attached one: a Wall shows a single
  // notepad, whichever Surface it belongs to (`docs/specs/notepad.md`).
  const openDoorNotepad = useCallback((item: DoorChip, anchor: HTMLElement) => {
    setOpenNotepadId(null);
    setDoorNotepad((current) => current?.id === item.id
      ? null
      : { id: item.id, rect: anchor.getBoundingClientRect(), unavailableNoteId: null });
  }, []);

  const closeDoorNotepad = useCallback(() => setDoorNotepad(null), []);

  /**
   * A pin in a Door's popover: close it, reattach the Surface, then follow the
   * source. The reveal waits a frame because it resolves against the live
   * terminal the reattach is only now mounting; a source that no longer exists
   * brings the popover back to say so.
   */
  const revealDoorSource = useCallback((noteId: string) => {
    const open = doorNotepad;
    if (!open) return;
    const item = items.find((candidate) => candidate.id === open.id);
    setDoorNotepad(null);
    if (item) onReattach(item);
    requestAnimationFrame(() => {
      if (revealNoteSource(open.id, noteId).ok) return;
      setDoorNotepad({ ...open, unavailableNoteId: noteId });
    });
  }, [doorNotepad, items, onReattach]);

  const scrollLeft = () => setStartIndex(Math.max(0, startIndex - 1));
  const scrollRight = () => setStartIndex(Math.min(items.length - 1, startIndex + 1));

  return (
    <div
      ref={containerRef}
      className="flex h-7 shrink-0 items-end gap-1.5 bg-app-bg px-1.75 pt-1"
    >
      {/* Hidden measurement pass — doors + overflow arrow */}
      <div ref={measureEl} className="absolute -left-[9999px] flex gap-1.5" aria-hidden>
        {items.map(item => <Door key={item.id} {...doorProps(item)} />)}
      </div>
      <button ref={arrowMeasureEl} className={`absolute -left-[9999px] ${BASEBOARD_BUTTON_CLASS}`} aria-hidden tabIndex={-1}>
        9 more <CaretRightIcon size={10} weight="bold" />
      </button>

      {items.length === 0 && showHint && (
        <span className="truncate pb-1 text-sm font-mono text-muted">
          {shortcutHint}
        </span>
      )}

      {hiddenLeft > 0 && (
        <button
          className={BASEBOARD_BUTTON_CLASS}
          onClick={scrollLeft}
        >
          <CaretLeftIcon size={10} weight="bold" />
          {hiddenLeft} more
        </button>
      )}

      {items.slice(startIndex, endIndex).map(item => (
        <Door
          key={item.id}
          doorId={item.id}
          {...doorProps(item)}
          onClick={() => onReattach(item)}
          onDragPress={onDoorDragStart ? (press) => onDoorDragStart(item, press) : undefined}
          onOpenNotepad={(anchor) => openDoorNotepad(item, anchor)}
        />
      ))}

      {/* One right-hand cluster. Previously the overflow arrow and the notice
          each carried their own `ml-auto`, which split the free space between
          them. The arrow keeps its per-iteration reserve in the fitting loop;
          only the always-present part below is measured, so cluster width never
          depends on the fitting result it feeds. */}
      <div className="ml-auto flex shrink-0 items-end gap-1.5">
        {hiddenRight > 0 && (
          <button
            className={BASEBOARD_BUTTON_CLASS}
            onClick={scrollRight}
          >
            {hiddenRight} more
            <CaretRightIcon size={10} weight="bold" />
          </button>
        )}

        <div ref={rightClusterEl} className="flex shrink-0 items-end gap-1.5">
          {notice}

          <button
            className={`${BASEBOARD_BUTTON_CLASS} ${settings.speakEnabled ? 'text-app-fg' : ''}`}
            aria-label={`Spoken alarms ${settings.speakEnabled ? 'enabled' : 'disabled'}; open Settings`}
            title={`Spoken alarms ${settings.speakEnabled ? 'enabled' : 'disabled'}`}
            aria-haspopup="dialog"
            data-alarm-setting="speech"
            onClick={() => setSettingsOpen(true)}
          >
            {settings.speakEnabled
              ? <SpeakerHighIcon size={16} weight="fill" />
              : <SpeakerSlashIcon size={16} weight="bold" />}
          </button>

          <button
            className={`${BASEBOARD_BUTTON_CLASS} ${settings.pushEnabled ? 'text-app-fg' : ''}`}
            aria-label={`Push notifications ${settings.pushEnabled ? 'enabled' : 'disabled'}; open Settings`}
            title={`Push notifications ${settings.pushEnabled ? 'enabled' : 'disabled'}`}
            aria-haspopup="dialog"
            data-alarm-setting="push"
            onClick={() => setSettingsOpen(true)}
          >
            {settings.pushEnabled
              ? <BellRingingIcon size={16} weight="fill" />
              : <BellSlashIcon size={16} weight="bold" />}
          </button>

          <button
            className={BASEBOARD_BUTTON_CLASS}
            aria-label="Settings"
            title="Settings"
            aria-haspopup="dialog"
            data-open-settings="true"
            onClick={() => setSettingsOpen(true)}
          >
            <SlidersHorizontalIcon size={16} weight="bold" />
          </button>
        </div>
      </div>

      {doorNotepad && (
        <DoorNotepadPopover
          surfaceId={doorNotepad.id}
          anchorRect={doorNotepad.rect}
          sourceUnavailableNoteId={doorNotepad.unavailableNoteId}
          onClose={closeDoorNotepad}
          onRevealSource={revealDoorSource}
          onKeyboardActiveChange={setDialogKeyboardActive}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
