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
 * Removal-side echoes are deliberately NOT tagged, anywhere: when a removal
 * invalidates state, dockview's activate-the-survivor echo is exactly what
 * self-heals selection — e.g. the kill path when the user had navigated onto a
 * fading pane, and the auto-spawn's `addPanel` echo that establishes selection on
 * the replacement pane in passthrough. Muting those would strand selection on a
 * gone pane. Only the add-side mutations that hand activation straight back to the
 * caller belong inside this wrapper.
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
