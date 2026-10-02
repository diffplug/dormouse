import type { Rect } from '../../lib/lath/model';
import { POPUP_SURFACE_CLASS, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { DragPreview } from './lath-drag-controller';

/** Temporary destination and affected scope; both are inert to the live drag. */
export function LathDropPreview({ preview, wall, color, zIndex }: {
  preview: DragPreview; wall: Rect; color: string; zIndex: number;
}) {
  const geometry = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
  const scope = preview.scopeRect ?? preview.rect;
  return <>
    {preview.scopeRect && <div
      data-lath-drop-scope=""
      className="pointer-events-none absolute"
      style={{ ...geometry(scope), zIndex, border: '1px dashed ' + color, borderRadius: TERMINAL_SELECTION_BORDER_RADIUS }}
    />}
    <div
      data-lath-drop-preview=""
      className="lath-drop-preview"
      style={{
        ...geometry(preview.rect), zIndex,
        border: '1px solid ' + color,
        borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
        backgroundColor: 'color-mix(in srgb, ' + color + ' 22%, transparent)',
      }}
    />
    <div
      data-lath-drop-choice=""
      role="status"
      className={POPUP_SURFACE_CLASS + ' pointer-events-none absolute px-2 py-1 text-sm'}
      style={{
        left: Math.min(scope.x + 8, Math.max(8, wall.width - 268)),
        top: Math.min(scope.y + 8, Math.max(8, wall.height - 40)),
        maxWidth: Math.max(0, Math.min(260, wall.width - 16)),
        zIndex: zIndex + 1,
      }}
    >
      {preview.label}
      {preview.count > 1 && <span> {'\u00b7'} {preview.choice}/{preview.count} {'\u00b7'} scroll to choose</span>}
    </div>
  </>;
}
