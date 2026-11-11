/**
 * The host half of output flow control (`docs/specs/transport.md` -> "Output
 * flow control"), run where each Node-resident host sends `pty:data`: the
 * standalone sidecar (`sidecar-entry.ts`) and VS Code's extension host
 * (`vscode-ext/src/pty-manager.ts`). Counts are UTF-16 code units of the sent
 * `data`, the unit its renderer acknowledges in, which is why this sits after
 * the parse rather than in `pty-core`.
 */
import { PTY_HIGH_WATERMARK_CHARS, PTY_LOW_WATERMARK_CHARS } from '../lib/pty-flow';

/** Where a decision lands: `pty-core`'s `pause` / `resume`, in process or over IPC. */
export interface PtyFlowTarget {
  pause(id: string): void;
  resume(id: string): void;
}

export interface PtyFlowControl {
  /** `chars` of `id`'s live output just went to its renderer as `pty:data`. */
  sent(id: string, chars: number): void;
  /** A renderer's acknowledgement. Anything but a positive integer is ignored. */
  acknowledge(id: string, chars: unknown): void;
  /**
   * Forgive what `ids` owe and resume them: the renderer that owed it can no
   * longer pay, or no longer needs to. Omitted is every PTY this holds.
   */
  reset(ids?: readonly string[]): void;
  /** `id`'s PTY is gone: drop its count, resuming nothing. */
  forget(id: string): void;
  /** What `id`'s renderer owes. */
  unacknowledged(id: string): number;
}

export function createPtyFlowControl(target: PtyFlowTarget): PtyFlowControl {
  /** Sent and not yet acknowledged, per PTY; absent is nothing owed. */
  const owed = new Map<string, number>();
  const paused = new Set<string>();

  const resume = (id: string) => {
    if (!paused.delete(id)) return;
    target.resume(id);
  };

  return {
    sent(id, chars) {
      if (chars <= 0) return;
      const total = (owed.get(id) ?? 0) + chars;
      owed.set(id, total);
      if (total <= PTY_HIGH_WATERMARK_CHARS || paused.has(id)) return;
      paused.add(id);
      target.pause(id);
    },

    acknowledge(id, chars) {
      if (typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars <= 0) return;
      const before = owed.get(id);
      // Nothing owed: a renderer paying for output sent before a reset.
      if (before === undefined) return;
      const total = Math.max(0, before - chars);
      if (total === 0) owed.delete(id);
      else owed.set(id, total);
      if (total <= PTY_LOW_WATERMARK_CHARS) resume(id);
    },

    reset(ids) {
      for (const id of ids ?? [...new Set([...owed.keys(), ...paused])]) {
        owed.delete(id);
        resume(id);
      }
    },

    forget(id) {
      owed.delete(id);
      paused.delete(id);
    },

    unacknowledged: (id) => owed.get(id) ?? 0,
  };
}
