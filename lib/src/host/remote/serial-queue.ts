/**
 * One-at-a-time execution for the Host's stores and its lifecycle.
 *
 * Everything that queues here is a read-modify-write of shared state across an
 * await — a whole-file rewrite, a keychain round trip, a Host that is read then
 * built — so two of them running together can interleave and land the older one
 * last, silently de-pairing a device or leaving a second relay socket nobody
 * holds a reference to.
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
