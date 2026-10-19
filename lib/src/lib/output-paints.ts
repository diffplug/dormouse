/**
 * Whether a chunk of renderer-bound output changes what the screen shows: the
 * test for whether it counts as the program working. An idle Claude Code asks
 * for the cursor position every 200 ms, and Codex answers a click with frames
 * that only reset colors and move the cursor; counting either kept a finished
 * agent busy forever, or made it look busy after a click.
 *
 * Only known-inert sequences are discounted — queries, modes, colors, cursor
 * motion, and every string control but a title, which the pane header shows —
 * and anything unrecognized paints, so a
 * misread errs toward the old count. A sequence split across chunks reads its
 * tail as text, which also errs toward painting.
 */
export function outputPaints(data: string): boolean {
  let i = 0;
  while (i < data.length) {
    const code = data.charCodeAt(i);
    if (code === 0x1b) {
      const next = data.charCodeAt(i + 1);
      if (next === 0x5b) { // ESC [
        const end = csiEnd(data, i + 2);
        if (end < 0 || csiPaints(data.slice(i + 2, end + 1))) return true;
        i = end + 1;
      } else if (next === 0x5d) { // ESC ]
        const end = stringEnd(data, i + 2);
        if (end < 0 || oscPaints(data, i + 2)) return true;
        i = end;
      } else if (next === 0x50) { // ESC P
        const end = stringEnd(data, i + 2);
        if (end < 0 || dcsPaints(data.slice(i + 2, end))) return true;
        i = end;
      } else if (next === 0x37 || next === 0x38 || next === 0x3d || next === 0x3e) { // save/restore cursor, keypad modes
        i += 2;
      } else if (next >= 0x28 && next <= 0x2b && i + 2 < data.length) { // charset designation
        i += 3;
      } else {
        return true; // index, reverse index, reset, APC graphics, …
      }
    } else if (code === 0x9b) { // C1 CSI
      const end = csiEnd(data, i + 1);
      if (end < 0 || csiPaints(data.slice(i + 1, end + 1))) return true;
      i = end + 1;
    } else if (code === 0x9d) { // C1 OSC
      const end = stringEnd(data, i + 1);
      if (end < 0 || oscPaints(data, i + 1)) return true;
      i = end;
    } else if (code === 0x90) { // C1 DCS
      const end = stringEnd(data, i + 1);
      if (end < 0 || dcsPaints(data.slice(i + 1, end))) return true;
      i = end;
    } else if (code === 0x0a || code === 0x0b || code === 0x0c) {
      return true; // a line feed can scroll
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      i += 1; // BEL, BS, HT, CR, shifts, other C0 and C1 controls
    } else {
      return true; // printable text, a space included
    }
  }
  return false;
}

/** The index of a CSI's final byte, or -1 when the chunk ends inside it. */
function csiEnd(data: string, from: number): number {
  for (let i = from; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i;
    if (code < 0x20 || code > 0x3f) return -1; // malformed: let it count
  }
  return -1;
}

/** The index just past a string control's terminator (BEL, ST, or C1 ST), or -1. */
function stringEnd(data: string, from: number): number {
  for (let i = from; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x07 || code === 0x9c) return i + 1;
    if (code === 0x1b && data.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return -1;
}

/** A title set (`OSC 0`, `1`, `2`); colors, notifications, cwd, links and the rest change no cell. */
function oscPaints(data: string, from: number): boolean {
  return /^[012];/.test(data.slice(from, from + 2));
}

/** Screen-buffer switches and reverse video: a mode change the user sees. */
const PAINTING_MODES = new Set(['5', '47', '1047', '1049']);

/** `body` is everything after the introducer, final byte included. */
function csiPaints(body: string): boolean {
  const final = body[body.length - 1];
  const prefix = /^[<=>?]/.test(body) ? body[0] : '';
  const intermediates = body.slice(0, -1).replace(/^[<=>?]?[0-9:;]*/, '');
  const params = body.slice(prefix.length, body.length - 1 - intermediates.length);
  if (intermediates === '') {
    if (prefix === '' && 'ABCDEFGHIZ`adefsr'.includes(final)) return false; // cursor motion, tab stops, save/restore, margins
    if ('mnct'.includes(final)) return false; // SGR and its key-mode cousins, reports, device attributes, window ops
    if (final === 'u') return false; // restore cursor, kitty keyboard flags
    if (final === 'q' && prefix === '>') return false; // XTVERSION
    if (final === 'S' && prefix === '?') return false; // XTSMGRAPHICS
    if (final === 'h' || final === 'l') return prefix === '?' && params.split(';').some(mode => PAINTING_MODES.has(mode));
    if (final === 'r' && prefix === '?') return false; // restore private modes
    return true;
  }
  if (intermediates === ' ' && final === 'q') return false; // cursor style
  if (intermediates === '$' && final === 'p') return false; // DECRQM
  return true;
}

/** `body` runs from after the introducer to the terminator: DECRQSS and XTGETTCAP ask, the rest (SIXEL, passthrough) may paint. */
function dcsPaints(body: string): boolean {
  return !/^[$+]q/.test(body);
}
