/**
 * Tracks agent-browser sessions Dormouse has *deliberately* closed (a pane kill,
 * or a render-swap away from the screencast/popout backend), so a popped-out
 * surface's auto-revert doesn't resurrect a session that's being torn down.
 *
 * The race (docs/specs/dor-browser.md → "Headed pop-out → Lifecycle"):
 * killing or swapping a popped-out surface issues `agent-browser … close`, which
 * drops the headed stream. The panel's auto-revert reads that dropped stream as
 * "the user closed the window" and relaunches the session headless — bringing
 * back a session (and process) that was meant to die. Marking the session closed
 * *before* issuing the close lets the auto-revert stand down.
 *
 * A managed session name can be re-created later (e.g. `dor ab` re-opening
 * `dormouse.1.default` after a kill), so a freshly-mounted panel clears the mark
 * for its session — the flag means "this specific live surface is going away,"
 * not "this name is forever dead."
 */
const closedSessions = new Set<string>();

/** Mark a session as being closed by Dormouse (call before issuing `close`). */
export function markAgentBrowserSessionClosed(session: string): void {
  closedSessions.add(session);
}

/** Clear the mark — a new surface is taking ownership of this session name. */
export function clearAgentBrowserSessionClosed(session: string): void {
  closedSessions.delete(session);
}

/** Whether Dormouse is deliberately tearing this session down right now. */
export function isAgentBrowserSessionClosed(session: string): boolean {
  return closedSessions.has(session);
}
