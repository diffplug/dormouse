/**
 * "Programmatic activation" tag — the single mechanism the Wall uses to tell a
 * programmatic dockview mutation apart from a genuine user activation.
 *
 * Why this exists: dockview fires `onDidActivePanelChange` for programmatic
 * `setActive`/`addPanel`/`fromJSON` exactly like it does for user activation
 * (click/drag/tab). The Wall's listener (`use-dockview-ready.ts`) must only
 * treat USER activation as selection intent, so add-side programmatic mutations
 * run inside `withProgrammaticActivation` and the listener ignores any
 * activation while the depth is > 0.
 *
 * Depth counter, not a boolean: tagged operations nest — e.g. `runSurfaceAdd`'s
 * `add` → `settleFocusAfterAdd` → `caller.api.setActive` each activate a panel,
 * and an inner scope may open a further tagged mutation. A boolean cleared in an
 * inner `finally` would unmute the outer scope early; incrementing/decrementing a
 * counter keeps the tag asserted until the outermost wrapper exits.
 *
 * Synchronicity assumption — the one place to re-verify on dockview upgrades:
 * dockview 5.2 fires these activation events synchronously, inside the mutation
 * call, so the synchronous wrap window below is airtight. A dockview version that
 * deferred activation events (microtask/timeout) would fire them after `finally`
 * has already decremented, escaping the tag; that upgrade must revisit this.
 *
 * Removal-side echoes are tagged only where the removal applies its own explicit
 * selection policy. The kill removal is tagged (`kill-animation.ts`): it decides
 * where selection lands with a live read at removal time, so dockview's
 * activate-the-survivor echo is redundant and muting it just stops a spurious
 * user-intent read. The other two removal-side echoes stay untagged and remain
 * load-bearing: the auto-spawn's `addPanel` echo establishes selection on the
 * replacement pane in passthrough, and `minimizePane`'s removal echo self-heals
 * selection when the user had navigated onto the minimized pane — muting either
 * would strand selection on a gone pane. Add-side mutations that hand activation
 * straight back to the caller always belong inside this wrapper.
 */
export type ProgrammaticActivationRef = { current: number };

export function withProgrammaticActivation<T>(ref: ProgrammaticActivationRef, fn: () => T): T {
  ref.current++;
  try {
    return fn();
  } finally {
    ref.current--;
  }
}
