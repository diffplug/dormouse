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

// The same bound for the one quit step that is allowed to *stop* the quit: the
// notepad archive gate, which must be able to say "these notes are not stored"
// (docs/specs/notepad.md -> "Standalone quit"). So unlike `withTimeout`, running
// out of time rejects, with a message the quit dialog shows verbatim.
export function withDeadline<T>(work: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
