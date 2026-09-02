/**
 * Copy Rewrapped heuristics. Two transformations per spec §4.1.2:
 *
 *  1. Unwrap hard newlines that look like display wrapping inside a flowing
 *     paragraph. Blank lines stay as paragraph separators.
 *  2. Strip runs of Unicode box-drawing characters that form UI chrome
 *     (frames, table borders), keeping the text they surround.
 *
 * The rules are deliberately simple first-cut heuristics — see the
 * mouse-and-clipboard spec §9.1 (Future) for the follow-up to refine them
 * based on dogfooding.
 */

// U+2500..U+257F is Box Drawing; U+2580..U+259F is Block Elements. We treat
// both as "frame-like" for stripping purposes, since double-line frames
// (U+2550..U+256C) fall in 2500..257F and heavy blocks (2588 etc.) are often
// used for the same visual effect.
const BOX_CHAR = /[\u2500-\u259F]/;
const FRAME_ONLY = /^[\u2500-\u259F\s]+$/;

function isFrameOnlyLine(line: string): boolean {
  if (line.length === 0) return false;
  if (!FRAME_ONLY.test(line)) return false;
  return BOX_CHAR.test(line);
}

function stripLeadingAndTrailingFrame(line: string): string {
  return line
    .replace(/^[\u2500-\u259F]+\s?/, '')
    .replace(/\s?[\u2500-\u259F]+$/, '');
}

/**
 * Core rewrap. See module doc.
 *
 * Block-shape selections should NOT be run through this — they're
 * intentionally rectangular slabs and the callers skip rewrap for them.
 */
export function rewrap(text: string): string {
  const rawLines = text.split('\n');

  // Pass 1: drop frame-only lines and strip leading/trailing box runs from
  // the rest.
  const cleaned = rawLines
    .filter((l) => !isFrameOnlyLine(l))
    .map((l) => stripLeadingAndTrailingFrame(l).trimEnd());

  // Pass 2: group into paragraphs. A blank line is a paragraph separator.
  // Lines within a paragraph are joined with a single space.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const raw of cleaned) {
    const line = raw.trim();
    if (line === '') {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current.join(' '));

  return paragraphs.join('\n\n');
}

// Exported for targeted unit tests.
export const __testing = { isFrameOnlyLine, stripLeadingAndTrailingFrame };
