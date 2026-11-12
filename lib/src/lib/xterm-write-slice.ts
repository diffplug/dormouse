import type { Terminal } from '@xterm/xterm';

/**
 * The one reach into xterm's private write loop, written against
 * `@xterm/xterm` 6.1.0-beta.337. xterm-write-slice.test.ts fails on the pinned
 * xterm if either member changes shape, so a bump cannot silently drop back
 * to parsing on timers alone.
 *
 * - `_core._writeBuffer._innerWrite()` is the body of xterm's write timer: it
 *   parses queued writes for one 12 ms slice, calls each write callback as its
 *   chunk finishes, chains an async parser handler's continuation on the
 *   handler's promise, and re-arms the timer for whatever remains.
 * - `_core._inputHandler._parseStack.paused` is true while such a continuation
 *   is owed. A slice then would resume the parser as though the handler had
 *   already returned `true`, and the continuation would fail the parser for
 *   good, so none runs.
 *
 * The public alternatives are unsafe here: `writeSync` is deprecated, and both
 * it and `flushSync` ignore an async handler's promise, which the image addon's
 * handlers return.
 */
interface WriteLoopInternals {
  _core?: {
    _writeBuffer?: { _innerWrite?: unknown };
    _inputHandler?: { _parseStack?: { paused?: unknown } };
  };
}

let reportedMissing = false;

/** Returns a function that parses one slice of `terminal`'s queued writes now,
 *  or null when this xterm lacks the members (logged once per page), in which
 *  case its timers alone parse. */
export function xtermWriteSlice(terminal: Terminal): (() => void) | null {
  const core = (terminal as unknown as WriteLoopInternals)._core;
  const writeBuffer = core?._writeBuffer;
  const parseStack = core?._inputHandler?._parseStack;
  if (typeof writeBuffer?._innerWrite !== 'function' || typeof parseStack?.paused !== 'boolean') {
    if (!reportedMissing) console.warn('[terminal] xterm\'s write loop has changed shape; a hidden window parses on timers alone');
    reportedMissing = true;
    return null;
  }
  const loop = writeBuffer as { _innerWrite(): void };
  return () => {
    if (!parseStack.paused) loop._innerWrite();
  };
}
