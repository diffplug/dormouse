/**
 * The host half of output flow control (`docs/specs/transport.md` -> "Output
 * flow control"), run where each Node-resident host sends `pty:data`: the
 * standalone sidecar (`sidecar-entry.ts`) and VS Code's extension host
 * (`vscode-ext/src/pty-manager.ts`). Counts are UTF-16 code units of the sent
 * `data`, the unit its renderer acknowledges in, which is why this sits after
 * the parse rather than in `pty-core`.
 */
import {
  PTY_HIGH_WATERMARK_CHARS,
  PTY_INPUT_CEILING_CHARS,
  PTY_INPUT_GRACE_MS,
  PTY_LOW_WATERMARK_CHARS,
} from '../lib/pty-flow';

/** Where a decision lands: `pty-core`'s `pause` / `resume`, in process or over IPC. */
export interface PtyFlowTarget {
  pause(id: string): void;
  resume(id: string): void;
}

export interface PtyFlowOptions {
  /** The platform of the process that owns node-pty; this one's by default. */
  platform?: string;
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
}

export function createPtyFlowControl(target: PtyFlowTarget, { platform = process.platform }: PtyFlowOptions = {}): PtyFlowControl {
  /** Sent and not yet acknowledged, per PTY; absent is nothing owed. */
  const owed = new Map<string, number>();
  const paused = new Set<string>();
  // ConPTY takes no input while its output is blocked (measured, see the
  // rationale), so on Windows input resumes a paused PTY for a grace after the
  // last write; POSIX's line discipline delivers it to the blocked program.
  const inputResumes = platform === 'win32';
  /** PTYs input has resumed past the high watermark, each with its grace timer. */
  const graces = new Map<string, ReturnType<typeof setTimeout>>();

  const pause = (id: string) => {
    paused.add(id);
    target.pause(id);
  };
  const resume = (id: string) => {
    if (!paused.delete(id)) return;
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
      if (total <= PTY_LOW_WATERMARK_CHARS) resume(id);
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
        owed.delete(id);
        endGrace(id);
        resume(id);
      }
    },

    forget(id) {
      owed.delete(id);
      paused.delete(id);
      endGrace(id);
    },

    unacknowledged: (id) => owed.get(id) ?? 0,
  };
}
