import { collectTerminalSemanticEvents, TerminalProtocolParser } from '../terminal-protocol';
import { applyTerminalSemanticEvents } from '../terminal-state-store';
import { themeColorProvider } from '../terminal-theme';
import { recordToolEvents } from '../tool-events';

/**
 * One `pty:replay`, parsed where it lands. Replay arrives as raw buffered
 * output, the one stream its host does not parse for the renderer, so a
 * one-shot parser rebuilds the renderer's Tool and semantic state from it and
 * strips what xterm.js must not see; the visible text is returned. Its reports
 * and responses are dropped: the host's own parse already fed its alerts and
 * answered (`docs/specs/terminal-escapes.md` → "Parsing location"). It still
 * takes the theme, because a *declined* colour query is not consumed and would
 * reach xterm.js instead, and answering is the owner's alone.
 */
export function parseReplay(id: string, data: string): string {
  const parsed = new TerminalProtocolParser(themeColorProvider).process(data);
  recordToolEvents(id, parsed.events);
  applyTerminalSemanticEvents(id, collectTerminalSemanticEvents(parsed.events));
  return parsed.visibleData;
}
