import type { Rect } from '../../lib/lath/model';
import { POPUP_SURFACE_CLASS, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { DragPreview } from './lath-drag-controller';

/** Temporary destination and affected scope (for a swap, the pane trading places); all
 *  inert to the live drag. */
export function LathDropPreview({ preview, wall, color, zIndex }: {
  preview: DragPreview; wall: Rect; color: string; zIndex: number;
}) {
  const geometry = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
  const { rect, scopeRect, swapRect } = preview;
  const badgeAt = scopeRect ?? rect;
  return <>
    {scopeRect && <div
      data-lath-drop-scope=""
      className="pointer-events-none absolute"
      style={{ ...geometry(scopeRect), zIndex, border: '1px dashed ' + color, borderRadius: TERMINAL_SELECTION_BORDER_RADIUS }}
    />}
    {swapRect && <div
      data-lath-drop-swap=""
      className="lath-drop-preview"
      style={{
        ...geometry(swapRect), zIndex,
        border: '1px dashed ' + color,
        borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
        backgroundColor: 'color-mix(in srgb, ' + color + ' 10%, transparent)',
      }}
    />}
    <div
      data-lath-drop-preview=""
      className="lath-drop-preview"
      style={{
        ...geometry(rect), zIndex,
        border: '1px solid ' + color,
        borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
        backgroundColor: 'color-mix(in srgb, ' + color + ' 22%, transparent)',
      }}
    />
    {preview.badge && <div
      data-lath-drop-choice=""
      role="status"
      className={POPUP_SURFACE_CLASS + ' pointer-events-none absolute px-2 py-1 text-sm'}
      style={{
        left: Math.min(badgeAt.x + 8, Math.max(8, wall.width - 268)),
        top: Math.min(badgeAt.y + 8, Math.max(8, wall.height - 40)),
        maxWidth: Math.max(0, Math.min(260, wall.width - 16)),
        zIndex: zIndex + 1,
      }}
    >
      {preview.badge}
    </div>}
  </>;
}
