import type { SlideGuide } from '../../lib/lath/hit-test';
import type { Rect } from '../../lib/lath/model';
import { PANE_GUTTER_PX, POPUP_SURFACE_CLASS, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { DragPreview } from './lath-drag-controller';

/** Length of the marks across the slide line at its ends and steps. */
const STOP_MARK_PX = 16;

/** Temporary destination and affected scope; both are inert to the live drag. */
export function LathDropPreview({ preview, wall, color, zIndex }: {
  preview: DragPreview; wall: Rect; color: string; zIndex: number;
}) {
  const geometry = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
  const { rect, scopeRect } = preview;
  return <>
    {scopeRect && <div
      data-lath-drop-scope=""
      className="pointer-events-none absolute"
      style={{ ...geometry(scopeRect), zIndex, border: '1px dashed ' + color, borderRadius: TERMINAL_SELECTION_BORDER_RADIUS }}
    />}
    {rect && <div
      data-lath-drop-preview=""
      className="lath-drop-preview"
      style={{
        ...geometry(rect), zIndex,
        border: '1px solid ' + color,
        borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
        backgroundColor: 'color-mix(in srgb, ' + color + ' 22%, transparent)',
      }}
    />}
    {preview.guide && <SlideLine guide={preview.guide} armed={preview.armed} wall={wall} color={color} zIndex={zIndex + 1} />}
    {preview.badge && scopeRect && <div
      data-lath-drop-choice=""
      role="status"
      className={POPUP_SURFACE_CLASS + ' pointer-events-none absolute px-2 py-1 text-sm'}
      style={{
        left: Math.min(scopeRect.x + 8, Math.max(8, wall.width - 268)),
        top: Math.min(scopeRect.y + 8, Math.max(8, wall.height - 40)),
        maxWidth: Math.max(0, Math.min(260, wall.width - 16)),
        zIndex: zIndex + 1,
      }}
    >
      {preview.badge}
    </div>}
  </>;
}

/** The line a drop can slide along, centered in the gutter outside the edge: dashed
 *  until a pause arms the slide, marked where the scope steps, the chosen scope bold. */
function SlideLine({ guide, armed, wall, color, zIndex }: {
  guide: SlideGuide; armed: boolean; wall: Rect; color: string; zIndex: number;
}) {
  const horizontal = guide.edge === 'top' || guide.edge === 'bottom';
  const outward = guide.edge === 'top' || guide.edge === 'left' ? -1 : 1;
  // The Wall clips what lies past its bounds, so a line on its outer edge moves inside.
  const reach = (horizontal ? wall.height : wall.width) - STOP_MARK_PX / 2;
  const across = Math.min(Math.max(guide.line + outward * PANE_GUTTER_PX / 2, STOP_MARK_PX / 2), reach);
  const bar = (from: number, to: number, thickness: number) => horizontal
    ? { left: from, width: to - from, top: across - thickness / 2, height: thickness }
    : { top: from, height: to - from, left: across - thickness / 2, width: thickness };
  const [start, end] = guide.extent;
  return <div data-lath-slide-guide="" data-armed={armed} className="pointer-events-none absolute inset-0" style={{ zIndex }}>
    <div className="absolute" style={{
      ...bar(start, end, 3),
      background: armed ? color : `repeating-linear-gradient(${horizontal ? 90 : 180}deg, ${color} 0 8px, transparent 8px 14px)`,
    }} />
    {[start, ...guide.stops, end].map((at) => <div
      key={at}
      data-lath-slide-stop=""
      className="absolute"
      style={{ ...bar(at - 1, at + 1, STOP_MARK_PX), background: color }}
    />)}
    <div data-lath-slide-scope="" className="absolute rounded-full" style={{ ...bar(guide.scope[0], guide.scope[1], 6), background: color }} />
  </div>;
}
