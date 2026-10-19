import type { Rect } from '../../lib/lath/model';
import { POPUP_SURFACE_CLASS, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { DragPreview } from './lath-drag-controller';

/** Temporary destination and affected scope (for a swap, the pane trading places); all
 *  inert to the live drag. */
export function LathDropPreview({ preview, wall, color, zIndex }: {
  preview: DragPreview; wall: Rect; color: string; zIndex: number;
}) {
  const { rect, scopeRect, swapRect } = preview;
  const box = (r: Rect, border: 'solid' | 'dashed', tintPct: number) => ({
    left: r.x, top: r.y, width: r.width, height: r.height, zIndex,
    border: `1px ${border} ${color}`,
    borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
    backgroundColor: tintPct > 0 ? `color-mix(in srgb, ${color} ${tintPct}%, transparent)` : undefined,
  });
  // A swap's badge sits at the center of the pane it trades with; a scope's at its corner.
  const corner = scopeRect ?? rect;
  const badgePosition = swapRect
    ? { left: rect.x + rect.width / 2, top: rect.y + rect.height / 2, transform: 'translate(-50%, -50%)' }
    : {
      left: Math.min(corner.x + 8, Math.max(8, wall.width - 268)),
      top: Math.min(corner.y + 8, Math.max(8, wall.height - 40)),
    };
  return <>
    {scopeRect && <div data-lath-drop-scope="" className="lath-drop-preview" style={box(scopeRect, 'dashed', 0)} />}
    {swapRect && <div data-lath-drop-swap="" className="lath-drop-preview" style={box(swapRect, 'dashed', 10)} />}
    <div data-lath-drop-preview="" className="lath-drop-preview" style={box(rect, 'solid', 22)} />
    {preview.badge && <div
      data-lath-drop-choice=""
      role="status"
      className={POPUP_SURFACE_CLASS + ' pointer-events-none absolute px-2 py-1 text-sm'}
      style={{
        ...badgePosition,
        maxWidth: Math.max(0, Math.min(260, wall.width - 16)),
        zIndex: zIndex + 1,
      }}
    >
      {preview.badge}
    </div>}
  </>;
}
