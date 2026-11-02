/**
 * One-at-a-time execution, for what must not interleave across an await. The
 * Burrow's stores and lifecycle are read-modify-writes of shared state — a
 * whole-file rewrite, a keychain round trip, a Burrow that is read then built —
 * so two running together can land the older one last, silently de-pairing a
 * device or leaving a second relay socket nobody holds a reference to. A framed
 * page's socket queues its messages here to keep them in order.
 */

/**
 * A queue that runs `work` after everything already queued and hands back its
 * result.
 *
 * The chain continues through a failure — one unwritable moment must not stop
 * every later save — while the caller still sees the rejection.
 */
export function createSerialQueue(): <T>(work: () => PromiseLike<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => PromiseLike<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
