import { PREVIEW_SUPERSEDED_ERROR } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import type { ToolOpen } from 'dor-tools-lib/osc';
import { dispatchDorControlRequest } from './platform/dor-control-dispatch';
import type { TerminalProtocolEvent } from './terminal-protocol';
import { getInheritableCwd } from './terminal-state-store';

/** Each Session's newest OSC 367 `open`, so a failed activate's retry never
 *  overtakes a newer request from the same Tool. */
const newest = new Map<string, number>();

/**
 * Act on a Session's OSC 367 `open` requests as `dor open` from that Session,
 * in stream order (`docs/specs/dor-tool.md` -> OSC 367). Called for live output
 * only: replay never re-opens anything. The Tool gets no reply; the request's
 * handler refuses one from anything but the Session's running designated Tool
 * and shows a failure in the preview slot.
 */
export function dispatchToolOpens(id: string, events: readonly TerminalProtocolEvent[]): void {
  for (const event of events) if (event.kind === 'toolOpen') dispatchToolOpen(id, event.open);
}

function dispatchToolOpen(id: string, { path, preview }: ToolOpen): void {
  const sequence = (newest.get(id) ?? 0) + 1;
  newest.set(id, sequence);
  requestOpen(id, path, preview, (failed) => {
    // A failed activate shows its failure in the slot as a failed select does.
    if (failed && !preview && newest.get(id) === sequence) requestOpen(id, path, true);
  });
}

function requestOpen(id: string, path: string, preview: boolean, settled?: (failed: boolean) => void): void {
  dispatchDorControlRequest({
    requestId: `osc-open-${crypto.randomUUID()}`,
    surfaceId: id,
    method: SURFACE_CONTROL_METHODS.tool,
    params: { file: path, preview, cwd: getInheritableCwd(id) ?? directoryOf(path), fresh: false, minimized: false },
  }, (response) => settled?.(!response.ok && response.error !== PREVIEW_SUPERSEDED_ERROR), { oscOpen: true });
}

/** The parent of an absolute native path; a root keeps its separator. */
function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = path.slice(0, cut);
  return /^([A-Za-z]:)?$/.test(dir) ? path.slice(0, cut + 1) : dir;
}
