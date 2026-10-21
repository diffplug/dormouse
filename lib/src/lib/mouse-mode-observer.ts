import type { Terminal, IDisposable } from '@xterm/xterm';
import { setBracketedPaste, setMouseReporting } from './mouse-selection';

/** Read resolved modes after parsing, including hard and soft resets. Watching
 *  only DECSET/DECRST misses resets, and guessing their effects would duplicate
 *  xterm's mode semantics. The store ignores unchanged values. */
export function attachMouseModeObserver(id: string, terminal: Terminal): IDisposable {
  return terminal.onWriteParsed(() => {
    setMouseReporting(id, terminal.modes.mouseTrackingMode);
    setBracketedPaste(id, terminal.modes.bracketedPasteMode);
  });
}
