/**
 * The host half of output flow control (`docs/specs/transport.md` -> "Output
 * flow control"), run where each Node-resident host sends `pty:data`: the
 * standalone sidecar (`sidecar-entry.ts`) and VS Code's extension host
 * (`vscode-ext/src/pty-manager.ts`). Counts are UTF-16 code units of the sent
 * `data`, the unit its renderer acknowledges in, which is why this sits after
 * the parse rather than in `pty-core`.
 */
import {
  PTY_ACK_WATCHDOG_MS,
  PTY_HIGH_WATERMARK_CHARS,
  PTY_INPUT_CEILING_CHARS,
  PTY_INPUT_GRACE_MS,
  PTY_LOW_WATERMARK_CHARS,
  PTY_PAUSED_PEEK_MS,
} from '../lib/pty-flow';

/** Where a decision lands: `pty-core`'s `pause` / `resume`, in process or over IPC. */
export interface PtyFlowTarget {
  pause(id: string): void;
  resume(id: string): void;
}

export interface PtyFlowOptions {
  /** The platform of the process that owns node-pty; this one's by default. */
  platform?: string;
  /** How long a paused PTY may go unacknowledged; `PTY_ACK_WATCHDOG_MS` by default. */
  watchdogMs?: number;
}

export interface PtyFlowControl {
  /** `chars` of `id`'s live output just went to its renderer as `pty:data`. */
  sent(id: string, chars: number): void;
  /** A renderer's acknowledgement. Anything but a positive integer is ignored. */
  acknowledge(id: string, chars: unknown): void;
  /** The host is writing input to `id`'s PTY: on Windows it must be read to arrive. */
  input(id: string): void;
  /**
   * Forgive what `ids` owe and resume them: the renderer that owed it can no
   * longer pay, or no longer needs to. Omitted is every PTY this holds.
   */
  reset(ids?: readonly string[]): void;
  /** `id`'s PTY is gone: drop its count, resuming nothing. */
  forget(id: string): void;
  /** What `id`'s renderer owes. */
  unacknowledged(id: string): number;
  /** Stop every timer this holds. */
  dispose(): void;
}

export function createPtyFlowControl(
  target: PtyFlowTarget,
  { platform = process.platform, watchdogMs = PTY_ACK_WATCHDOG_MS }: PtyFlowOptions = {},
): PtyFlowControl {
  /** Sent and not yet acknowledged, per PTY; absent is nothing owed. */
  const owed = new Map<string, number>();
  const paused = new Set<string>();
  // ConPTY takes no input while its output is blocked (measured, see the
  // rationale), so on Windows input resumes a paused PTY for a grace after the
  // last write; POSIX's line discipline delivers it to the blocked program.
  const inputResumes = platform === 'win32';
  /** PTYs input has resumed past the high watermark, each with its grace timer. */
  const graces = new Map<string, ReturnType<typeof setTimeout>>();
  // macOS holds an exiting program's close while more than 1,024 bytes are
  // unread, then discards all past the first 1,024 (measured, see the
  // rationale), and nothing shows the hold. So a paused PTY there is read once
  // every peek, below the ceiling.
  const peeks = platform === 'darwin';
  const peekTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Paused PTYs resumed for one read, paused again by the read it delivers. */
  const peeking = new Set<string>();
  // The clock runs from a pause until an acknowledgement. Only an
  // acknowledgement restarts it, so neither a peek nor input's grace, which
  // resume and re-pause the PTY, can hold it off.
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** PTYs the watchdog has resumed since their renderer last acknowledged. */
  const reported = new Set<string>();

  const stopPeeks = (id: string) => {
    clearInterval(peekTimers.get(id));
    peekTimers.delete(id);
    peeking.delete(id);
  };
  const stopWatchdog = (id: string) => {
    clearTimeout(watchdogs.get(id));
    watchdogs.delete(id);
  };
  const forgive = (id: string) => {
    owed.delete(id);
    endGrace(id);
    resume(id);
  };
  const armWatchdog = (id: string) => {
    if (watchdogs.has(id)) return;
    const timer = setTimeout(() => {
      watchdogs.delete(id);
      if (!reported.has(id)) console.warn(`[pty-flow] ${id}: no acknowledgement for ${watchdogMs} ms while paused; resuming it`);
      reported.add(id);
      forgive(id);
    }, watchdogMs);
    (timer as { unref?: () => void }).unref?.();
    watchdogs.set(id, timer);
  };
  const pause = (id: string) => {
    paused.add(id);
    target.pause(id);
    armWatchdog(id);
    if (!peeks || peekTimers.has(id)) return;
    const timer = setInterval(() => {
      if (!paused.has(id) || peeking.has(id) || (owed.get(id) ?? 0) >= PTY_INPUT_CEILING_CHARS) return;
      peeking.add(id);
      target.resume(id);
    }, PTY_PAUSED_PEEK_MS);
    (timer as { unref?: () => void }).unref?.();
    peekTimers.set(id, timer);
  };
  const resume = (id: string) => {
    if (!paused.delete(id)) return;
    stopPeeks(id);
    target.resume(id);
  };
  const endGrace = (id: string) => {
    clearTimeout(graces.get(id));
    graces.delete(id);
  };
  const armGrace = (id: string) => {
    endGrace(id);
    const timer = setTimeout(() => {
      graces.delete(id);
      if ((owed.get(id) ?? 0) > PTY_HIGH_WATERMARK_CHARS && !paused.has(id)) pause(id);
    }, PTY_INPUT_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    graces.set(id, timer);
  };

  return {
    sent(id, chars) {
      if (chars <= 0) return;
      const total = (owed.get(id) ?? 0) + chars;
      owed.set(id, total);
      if (peeking.delete(id)) {
        target.pause(id);
        return;
      }
      if (paused.has(id)) return;
      // Input's grace holds the PTY open up to the ceiling, never past it.
      const limit = graces.has(id) ? PTY_INPUT_CEILING_CHARS - 1 : PTY_HIGH_WATERMARK_CHARS;
      if (total <= limit) return;
      endGrace(id);
      pause(id);
    },

    acknowledge(id, chars) {
      if (typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars <= 0) return;
      const before = owed.get(id);
      // Nothing owed: a renderer paying for output sent before a reset.
      if (before === undefined) return;
      const total = Math.max(0, before - chars);
      if (total === 0) owed.delete(id);
      else owed.set(id, total);
      stopWatchdog(id);
      reported.delete(id);
      if (total <= PTY_LOW_WATERMARK_CHARS) resume(id);
      else if (paused.has(id)) armWatchdog(id);
    },

    input(id) {
      if (!inputResumes) return;
      if (paused.has(id)) {
        // At the ceiling the input still goes in, and arrives once the
        // renderer catches up: memory stays bounded however much is typed.
        if ((owed.get(id) ?? 0) >= PTY_INPUT_CEILING_CHARS) return;
        resume(id);
      } else if (!graces.has(id)) return;
      armGrace(id);
    },

    reset(ids) {
      for (const id of ids ?? [...new Set([...owed.keys(), ...paused])]) {
        stopWatchdog(id);
        reported.delete(id);
        forgive(id);
      }
    },

    forget(id) {
      owed.delete(id);
      paused.delete(id);
      endGrace(id);
      stopPeeks(id);
      stopWatchdog(id);
      reported.delete(id);
    },

    unacknowledged: (id) => owed.get(id) ?? 0,

    dispose() {
      for (const id of [...graces.keys()]) endGrace(id);
      for (const id of [...peekTimers.keys()]) stopPeeks(id);
      for (const id of [...watchdogs.keys()]) stopWatchdog(id);
    },
  };
}
