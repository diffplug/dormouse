import type { TerminalProtocolEvent } from './terminal-protocol';
import { clearToolAnnounce, recordToolAnnounce } from './tool-announce-store';
import { recordToolDirty } from './tool-dirty-store';
import { dispatchToolOpens } from './tool-open-requests';
import { offerToolDehydrate } from './tool-reap-store';

/** A parsed OSC start, the boundary at which a Session's previous run ends. */
export function isProtocolCommandStart(event: TerminalProtocolEvent): boolean {
  return event.kind === 'semantic' && event.event.type === 'commandStart';
}

/** Forget a Session's previous run's reports: its announcement and unsaved state. */
export function forgetToolReports(id: string): void {
  clearToolAnnounce(id);
  recordToolDirty(id, null);
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
    else if (isProtocolCommandStart(event)) forgetToolReports(id);
  }
}

/** A live parse's Tool events: recorded as replay's are, then the `open`
 *  requests and `dehydrate` payloads only live output makes
 *  (`docs/specs/dor-tool.md` -> OSC 367). */
export function applyLiveToolEvents(id: string, events: readonly TerminalProtocolEvent[]): void {
  recordToolEvents(id, events);
  for (const event of events) if (event.kind === 'toolDehydrate') offerToolDehydrate(id, event.dehydrate.payload);
  dispatchToolOpens(id, events);
}
