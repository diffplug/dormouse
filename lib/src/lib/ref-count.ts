/**
 * One window-wide resource shared by N holders: the first holder arms it and the
 * last one disarms it. Every Wall-scoped hook that has to run exactly once per
 * Window (the spoken alarms, the dynamic palette, the dev-server scan loop, the
 * `dor` router's window listener) takes one of these instead of hand-rolling the
 * counter, so a double release cannot drive the count negative and strand the
 * resource armed.
 */
export interface RefCountOptions {
  /** Arm the resource. Its return value is the disarm, run when the last holder
   *  releases. */
  onFirst: () => (() => void) | void;
  /** A holder joined or left an already-armed resource (the count changed
   *  without crossing the 0/1 boundary). For a resource whose answer depends on
   *  who is holding it — the port scan's Wall set — this is where it
   *  re-validates. */
  onChange?: (count: number) => void;
}

/** Take a share of the resource. The returned release is idempotent: calling it
 *  twice — StrictMode's double teardown, a cleanup that also runs on unmount —
 *  drops one share, never two. */
export type AcquireRefCount = () => () => void;

export function createRefCount({ onFirst, onChange }: RefCountOptions): AcquireRefCount {
  let holders = 0;
  let disarm: (() => void) | void;
  return () => {
    holders += 1;
    if (holders === 1) disarm = onFirst();
    else onChange?.(holders);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders > 0) {
        onChange?.(holders);
        return;
      }
      disarm?.();
      disarm = undefined;
    };
  };
}
