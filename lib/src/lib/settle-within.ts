/**
 * Settle a batch of best-effort answers under one shared deadline.
 *
 * Every entry is raced against the *same* timer rather than arming one apiece,
 * so a close waiting on twenty PTYs waits once. An entry that rejects or does
 * not arrive in time yields `fallback` and nothing else: the answers that did
 * arrive are kept, in input order. The timer is cleared as soon as the batch
 * settles, so an early completion leaves nothing pending behind it.
 *
 * Every caller here is asking a host something it would rather have than not —
 * a live process's working directory — where a missing answer is a fallback,
 * never a failure.
 */
export function settleAllWithin<T>(
  works: readonly Promise<T>[],
  ms: number,
  fallback: T,
): Promise<T[]> {
  if (works.length === 0) return Promise.resolve([]);
  let expire: (value: T) => void = () => {};
  const deadline = new Promise<T>((resolve) => {
    expire = resolve;
  });
  const timer = setTimeout(() => expire(fallback), ms);
  return Promise.all(
    works.map((work) => Promise.race([work.catch(() => fallback), deadline])),
  ).finally(() => clearTimeout(timer));
}
