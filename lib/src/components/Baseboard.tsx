import { useRef, useState, useMemo, useLayoutEffect, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { Door } from './Door';
import { DoorElementsContext } from './wall/wall-context';
import type { DooredItem } from './wall/wall-types';
import { IS_MAC } from '../lib/platform';
import {
  buildAppTitleResolver,
  DEFAULT_ACTIVITY_STATE,
  getActivitySnapshot,
  getTerminalPaneStateSnapshot,
  subscribeToActivity,
  subscribeToTerminalPaneState,
} from '../lib/terminal-registry';
import { createTerminalPaneState, deriveSurfaceLabel, type TerminalPaneState } from '../lib/terminal-state';

export interface BaseboardProps {
  items: DooredItem[];
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
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  const allPaneStates = useMemo(() => [...terminalStates.values()], [terminalStates]);
  const appTitleForPane = useMemo(
    () => buildAppTitleResolver(terminalStates, activityStates),
    [terminalStates, activityStates],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  const doorWidthsRef = useRef<number[]>([]);
  const arrowMeasureEl = useRef<HTMLButtonElement>(null);
  const layoutMetrics = useRef({ doorGap: 0, arrowWidth: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure door widths from hidden elements — re-measures when items change
  const measureEl = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = measureEl.current;
    if (!el) return;
    const widths: number[] = [];
    for (let i = 0; i < el.children.length; i++) {
      widths.push((el.children[i] as HTMLElement).offsetWidth);
    }
    doorWidthsRef.current = widths;

    // Measure layout metrics from DOM to stay in sync with CSS classes
    const container = containerRef.current;
    if (container) {
      layoutMetrics.current.doorGap = parseFloat(getComputedStyle(container).gap) || 0;
    }
    if (arrowMeasureEl.current) {
      layoutMetrics.current.arrowWidth = arrowMeasureEl.current.offsetWidth;
    }
  }, [items, activityStates, terminalStates]);

  // Reset startIndex when the set of door items changes (not just count)
  const itemKey = useMemo(() => items.map(i => i.id).join('\0'), [items]);
  useLayoutEffect(() => {
    setStartIndex(0);
  }, [itemKey]);

  // Keyboard shortcut hint — only show when there's enough space and no doors
  const shortcutHint = IS_MAC
    ? 'LCmd → RCmd to enter command mode'
    : 'LShift → RShift to enter command mode';
  const showHint = items.length === 0 && containerWidth > 350;

  // Calculate which doors fit
  // contentRect.width already excludes container padding
  const availableWidth = containerWidth;
  let visibleCount = 0;
  let usedWidth = 0;

  if (items.length > 0) {
    const widths = doorWidthsRef.current;
    const { doorGap, arrowWidth } = layoutMetrics.current;
    const hasLeftOverflow = startIndex > 0;
    let budget = availableWidth - (hasLeftOverflow ? arrowWidth : 0);

    for (let i = startIndex; i < items.length; i++) {
      const doorW = (widths[i] || 100) + (visibleCount > 0 ? doorGap : 0);
      // Reserve space for right arrow if there are more items after this one
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

  const scrollLeft = () => setStartIndex(Math.max(0, startIndex - 1));
  const scrollRight = () => setStartIndex(Math.min(items.length - 1, startIndex + 1));

  return (
    <div
      ref={containerRef}
      className="flex h-7 shrink-0 items-end gap-1.5 bg-app-bg px-1.5 pt-1"
    >
      {/* Hidden measurement pass — doors + overflow arrow */}
      <div ref={measureEl} className="absolute -left-[9999px] flex gap-1.5" aria-hidden>
        {items.map(item => {
          const activity = activityStates.get(item.id) ?? DEFAULT_ACTIVITY_STATE;
          const title = deriveDoorTitle(item.title, item.id, terminalStates, allPaneStates, appTitleForPane);
          return (
            <Door
              key={item.id}
              title={title}
              status={activity.status}
              todo={activity.todo}

            />
          );
        })}
      </div>
      <button ref={arrowMeasureEl} className="absolute -left-[9999px] flex h-5 shrink-0 items-center gap-1 rounded px-1.5 pb-px text-sm font-medium font-mono text-muted" aria-hidden tabIndex={-1}>
        9 more <CaretRightIcon size={10} weight="bold" />
      </button>

      {items.length === 0 && showHint && (
        <span className="truncate pb-1 text-sm font-mono text-muted">
          {shortcutHint}
        </span>
      )}

      {hiddenLeft > 0 && (
        <button
          className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 pb-px text-sm font-medium font-mono text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
          onClick={scrollLeft}
        >
          <CaretLeftIcon size={10} weight="bold" />
          {hiddenLeft} more
        </button>
      )}

      {items.slice(startIndex, endIndex).map(item => {
        const activity = activityStates.get(item.id) ?? DEFAULT_ACTIVITY_STATE;
        const title = deriveDoorTitle(item.title, item.id, terminalStates, allPaneStates, appTitleForPane);
        return (
          <Door
            key={item.id}
            doorId={item.id}
            title={title}
            status={activity.status}
            todo={activity.todo}
            onClick={() => onReattach(item)}
            onDragPress={onDoorDragStart ? (press) => onDoorDragStart(item, press) : undefined}
          />
        );
      })}

      {hiddenRight > 0 && (
        <button
          className="ml-auto flex h-5 shrink-0 items-center gap-1 rounded px-1.5 pb-px text-sm font-medium font-mono text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
          onClick={scrollRight}
        >
          {hiddenRight} more
          <CaretRightIcon size={10} weight="bold" />
        </button>
      )}

      {notice && <div className="ml-auto shrink-0">{notice}</div>}
    </div>
  );
}

function deriveDoorTitle(
  savedTitle: string,
  id: string,
  terminalStates: Map<string, TerminalPaneState>,
  allPaneStates: TerminalPaneState[],
  appTitleForPane: (pane: TerminalPaneState) => string | null | undefined,
): string {
  const paneState = terminalStates.get(id) ?? createTerminalPaneState();
  const visible = allPaneStates.length > 0 ? allPaneStates : [paneState];
  return deriveSurfaceLabel(paneState, visible, appTitleForPane, savedTitle);
}
