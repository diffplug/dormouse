/**
 * "Programmatic activation" tag — the single mechanism the Wall uses to tell a
 * programmatic dockview mutation apart from a genuine user activation.
 *
 * Why this exists: dockview fires `onDidActivePanelChange` for programmatic
 * `setActive`/`addPanel`/`fromJSON` exactly like it does for user activation
 * (click/drag/tab). The Wall's listener (`use-dockview-ready.ts`) must only
 * treat USER activation as selection intent, so programmatic mutations run
 * inside `withProgrammaticActivation` and the listener ignores any activation
 * while the depth is > 0.
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
 * Coverage is now total: every programmatic dockview mutation runs tagged — the
 * focus-neutral surface adds, `selectPane`/`enterTerminalMode`'s own `setActive`,
 * reattach's restore mutations, the kill removal (`kill-animation.ts`),
 * `minimizePane`'s removal, and the empty-pane auto-spawn's `addPanel`
 * (`use-dockview-ready.ts`). So an untagged activation IS a dockview-native user
 * interaction the React click handlers don't cover — a panel drag, or DOM focus
 * landing in a surface (an embed focusing itself) — and the listener adopts it
 * unconditionally through the real dispatchers. Selection policy lives at each
 * mutation site instead of in the listener: the kill tail's live read at removal
 * time, the auto-spawn's adopt-only-when-null-or-dangling, minimize's
 * `selectDoor`, and reattach's explicit `selectPane`/`enterTerminalMode`. The
 * self-healing a removal echo used to provide now lives inside those explicit
 * policies.
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
