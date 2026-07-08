// Bounded wait for quit-path steps: resolves when `work` settles or after `ms`
// (warning logged; a timeout never rejects — quit must proceed regardless). A
// rejection from `work` itself propagates to the caller. The timer is cleared
// on every outcome.
export function withTimeout(work: Promise<void>, ms: number, warnMessage: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(warnMessage);
      resolve();
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
