import { useContext, useEffect, useState, type CSSProperties, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  DOOR_SELECTION_BORDER_RADIUS,
  TERMINAL_SELECTION_BORDER_RADIUS,
} from '../design';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneGroupElement } from '../../lib/spatial-nav';
import type { WallMode, WallSelectionKind } from './wall-types';
import { DoorElementsContext, PaneElementsContext, WindowFocusedContext } from './wall-context';
import { MarchingAntsRect } from './MarchingAntsRect';

export function WorkspaceSelectionOverlay({ apiRef, selectedId, selectedType, mode, overlayElRef }: {
  apiRef: RefObject<DockviewApi | null>;
  selectedId: string | null;
  selectedType: WallSelectionKind;
  mode: WallMode;
  overlayElRef?: RefObject<HTMLDivElement | null>;
}) {
  const { elements: paneElements, version: paneVersion } = useContext(PaneElementsContext);
  const { elements: doorElements, version: doorVersion } = useContext(DoorElementsContext);
  const selectionColor = useFocusRingColor();
  const windowFocused = useContext(WindowFocusedContext);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const isDoor = selectedType === 'door';

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !selectedId) {
      setRect(null);
      return;
    }

    const INFLATE = 3;

    const update = () => {
      const targetEl = selectedType === 'door'
        ? doorElements.get(selectedId)
        : resolvePaneGroupElement(api, selectedId, paneElements);
      if (!targetEl) return;

      const targetRect = targetEl.getBoundingClientRect();
      const inflate = selectedType === 'door' ? 0 : INFLATE;
      setRect({
        top: targetRect.top - inflate,
        left: targetRect.left - inflate,
        width: targetRect.width + inflate * 2,
        height: targetRect.height + inflate * 2,
      });
    };

    update();

    const ro = new ResizeObserver(update);
    const panelEl = resolvePaneGroupElement(api, selectedId, paneElements);
    if (panelEl) ro.observe(panelEl);
    const doorEl = doorElements.get(selectedId);
    if (doorEl) ro.observe(doorEl);

    const d = api.onDidLayoutChange(update);

    return () => { ro.disconnect(); d.dispose(); };
  }, [apiRef, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements]);

  if (!rect || !selectedId) return null;

  const style: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    zIndex: 50,
    transition: 'top 150ms, left 150ms, width 150ms, height 150ms, filter 200ms',
    filter: windowFocused ? undefined : 'saturate(0.3)',
  };

  if (mode === 'passthrough') {
    style.borderRadius = isDoor ? DOOR_SELECTION_BORDER_RADIUS : TERMINAL_SELECTION_BORDER_RADIUS;
    style.border = `1px solid ${selectionColor}`;
    return <div ref={overlayElRef} style={style} />;
  }

  return (
    <div ref={overlayElRef} style={style}>
      <MarchingAntsRect
        width={rect.width}
        height={rect.height}
        isDoor={isDoor}
        color={selectionColor}
        paused={!windowFocused}
      />
    </div>
  );
}
