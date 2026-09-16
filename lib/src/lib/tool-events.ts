import type { TerminalProtocolEvent } from './terminal-protocol';
import { clearToolAnnounce, recordToolAnnounce } from './tool-announce-store';
import { recordToolDirty } from './tool-dirty-store';

/** A parsed OSC start, the boundary at which a Session's previous run ends. */
export function isProtocolCommandStart(event: TerminalProtocolEvent): boolean {
  return event.kind === 'semantic' && event.event.type === 'commandStart';
}

/** The one spelling of "record whatever Tool reports this parse produced",
 *  shared by every renderer-side seam that parses raw replay itself.
 *  Preserve stream order: a fresh command retires the previous run's
 *  announcement and state, but a report later in the same chunk belongs to
 *  the new run. A finish is not a save; only a start or an explicit report
 *  replaces the previous state. */
export function recordToolEvents(id: string, events: readonly TerminalProtocolEvent[]): void {
  for (const event of events) {
    if (event.kind === 'toolAnnounce') recordToolAnnounce(id, event.announce);
    else if (event.kind === 'toolState') recordToolDirty(id, event.state.dirty);
    else if (isProtocolCommandStart(event)) { clearToolAnnounce(id); recordToolDirty(id, null); }
  }
}
