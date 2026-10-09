/** The pure half of the built-in pages' tooltips (./tooltip.ts): what a tip
 * says and where it sits. */

/** One run of a tip's line: plain text, or the inside of a `[k]` shortcut. */
export interface TipPart { text: string; key: boolean }

// `[k]` is a shortcut, as lib's `renderShortcuts` reads it; `[]]` spells the
// `]` key, which that pattern cannot.
const SHORTCUT = /\[(\]|[^\]]+)\]/g;

/** A tip's text as lines, each line as runs: an authored hint (`data-tip`)
 * split at each newline, each `[k]` in it a shortcut; or `literal` text (a
 * name, a path: `data-tip-text`) as one plain run, each line break a space. */
export function tipLines(text: string, literal = false): TipPart[][] {
  if (literal) return [[{ text: text.replace(/\r\n?|[\n\u2028\u2029]/g, ' '), key: false }]];
  return text.split('\n').map(line => {
    const parts: TipPart[] = [];
    let last = 0;
    for (const match of line.matchAll(SHORTCUT)) {
      if (match.index > last) parts.push({ text: line.slice(last, match.index), key: false });
      parts.push({ text: match[1], key: true });
      last = match.index + match[0].length;
    }
    if (last < line.length) parts.push({ text: line.slice(last), key: false });
    return parts;
  });
}

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }

/** The gap between a control and its tip. */
export const TIP_GAP = 8;
/** The closest a tip comes to the viewport's edge. */
export const TIP_MARGIN = 4;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Where a tip of `size` goes for a control at `anchor`: `TIP_GAP` below it,
 * or above it when only there it fits, aligned to the control's edge on the
 * side of the viewport the control is in, then clamped inside the viewport. */
export function placeTip(anchor: Box, size: Size, viewport: Size): { left: number; top: number; above: boolean } {
  const inLeftHalf = anchor.left + anchor.right <= viewport.width;
  const left = clamp(inLeftHalf ? anchor.left : anchor.right - size.width, TIP_MARGIN, viewport.width - TIP_MARGIN - size.width);
  const below = anchor.bottom + TIP_GAP, above = anchor.top - TIP_GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - TIP_MARGIN;
  // Neither fits: the side with more room, overlapping the control if it must.
  const flip = !fitsBelow && (above >= TIP_MARGIN || anchor.top > viewport.height - anchor.bottom);
  return { left, top: clamp(flip ? above : below, TIP_MARGIN, viewport.height - TIP_MARGIN - size.height), above: flip };
}
