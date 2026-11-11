import type { Terminal } from '@xterm/xterm';
import { xtermWriteSlice } from './xterm-write-slice';

/** How long written output may wait with no write finishing, while more
 *  arrives, before arrivals parse it: xterm's timers are starved, as in a
 *  window its host throttles without reporting it hidden. */
export const PARSE_STARVED_MS = 1_000;

/**
 * Returns a write for `terminal` that keeps output parsing when xterm's timers
 * cannot: while the page is hidden, or once written output is starved. Each
 * arrival then runs one of xterm's own parse slices, in a microtask, so never
 * inside xterm's write loop and never more than a slice per arrival. A visible
 * page with an empty queue goes back to xterm's timers alone.
 *
 * `parsed` runs once, after xterm has parsed its chunk, whichever path parsed
 * it. A write xterm refuses throws, as `Terminal.write` does.
 */
export function parseOnArrival(terminal: Terminal): (data: string, parsed?: () => void) => void {
  const slice = xtermWriteSlice(terminal);
  if (!slice) return (data, parsed) => terminal.write(data, parsed);
  let unparsed = 0;
  let progressAt = 0;
  let eager = false;
  const runSlice = () => { if (unparsed > 0) slice(); };
  return (data, parsed) => {
    const now = Date.now();
    if (unparsed === 0) {
      progressAt = now;
      eager = false;
    }
    unparsed++;
    try {
      terminal.write(data, () => {
        unparsed--;
        progressAt = Date.now();
        parsed?.();
      });
    } catch (error) {
      unparsed--;
      throw error;
    }
    // Starvation persists until the queue empties: one slice resets the clock,
    // and xterm's timers are no healthier for it.
    eager ||= document.hidden || now - progressAt >= PARSE_STARVED_MS;
    if (eager) queueMicrotask(runSlice);
  };
}
