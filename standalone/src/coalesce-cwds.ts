/**
 * One `pty_get_cwds` for every Workspace asking at once.
 *
 * A quit flush fans out to every Wall concurrently and each answers with its own
 * `getCwds`, so N Workspaces cost N sidecar round trips — and, on macOS, N `lsof`
 * spawns on the sidecar's only event loop, serialized inside the shutdown budget.
 * Batching is already the rule one layer down (`getCwdsForPids` in
 * `standalone/sidecar/pty-core.js`); this extends it across the callers.
 *
 * Shared by both standalone adapters, which differ only in how they invoke.
 */

/** Ask the host for these ids' cwds. Answers a key per requested id. */
export type CwdInvoke = (ids: string[]) => Promise<Record<string, string | null>>;

/**
 * Wrap `invoke` so calls arriving before the current microtask drains become one
 * request. The window is a microtask, not a timer: a save must never wait on a
 * clock, and the fan-out this exists for is synchronous — every Wall reacts to
 * the same flush request.
 */
export function coalesceCwds(invoke: CwdInvoke): CwdInvoke {
  // The batch being filled, if one is open. Cleared the moment it is sent, so a
  // call arriving after that opens the next one instead of joining a request
  // already in flight.
  let pending: { ids: Set<string>; result: Promise<Record<string, string | null>> } | null = null;

  return async (ids: string[]): Promise<Record<string, string | null>> => {
    let batch = pending;
    if (!batch) {
      const opened: { ids: Set<string>; result?: Promise<Record<string, string | null>> } = {
        ids: new Set(ids),
      };
      opened.result = Promise.resolve().then(() => {
        pending = null;
        return invoke([...opened.ids]);
      });
      batch = opened as { ids: Set<string>; result: Promise<Record<string, string | null>> };
      pending = batch;
    } else {
      for (const id of ids) batch.ids.add(id);
    }
    const all = await batch.result;
    // Each caller sees only what it asked for, keyed for every id it named — the
    // shape a single `getCwds` answers with.
    const mine: Record<string, string | null> = {};
    for (const id of ids) mine[id] = all[id] ?? null;
    return mine;
  };
}
