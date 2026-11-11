/**
 * Output flow control between a PTY host and its renderer
 * (`docs/specs/transport.md` -> "Output flow control"). The renderer
 * acknowledges the live output it has parsed; the host pauses a PTY whose
 * unacknowledged output passes the high watermark and resumes it at the low
 * one. Every count is UTF-16 code units of `PtyDataDetail.data`. Both ends
 * import these constants: the renderer here, the hosts through
 * `lib/src/host/pty-flow-host.ts`.
 */
import type { PtyDataClaim, PtyDataDetail, PtyDataHandler } from './platform/types';

// Sized by measurement (docs/specs/transport.rationale.md -> "Output flow
// control"): the low watermark keeps the renderer parsing through a resume's
// round trip, and the high one bounds what a terminal can hold unparsed.

/** The renderer sends one acknowledgement per this many parsed chars of an id. */
export const PTY_ACK_BATCH_CHARS = 262_144;
/** The host pauses a PTY once more than this many sent chars are unacknowledged. */
export const PTY_HIGH_WATERMARK_CHARS = 2_097_152;
/**
 * The host resumes a paused PTY at or below this many. **Must stay at or above
 * `PTY_ACK_BATCH_CHARS - 1`**: what a renderer has parsed but not yet
 * acknowledged is always below one batch, and a PTY paused above that residue
 * would never resume.
 */
export const PTY_LOW_WATERMARK_CHARS = 1_048_576;
/**
 * On Windows, input written to a paused PTY resumes it until no input has
 * been written for this long; then it pauses again if still past the high
 * watermark. ConPTY delivered an interrupt 16 ms after the resume.
 */
export const PTY_INPUT_GRACE_MS = 250;
/** Neither input nor a peek resumes a PTY owing this many chars or more. */
export const PTY_INPUT_CEILING_CHARS = 2 * PTY_HIGH_WATERMARK_CHARS;
/**
 * On macOS a paused PTY is resumed for one read this often: an exiting
 * program with more than about 1 KB unread is held ~600 ms, then loses it.
 */
export const PTY_PAUSED_PEEK_MS = 150;

/**
 * The live-output dispatch every adapter shares: it calls each `onPtyData`
 * handler, keeps one handler's throw from reaching the next or the transport,
 * and acknowledges every char of every chunk exactly once — when the handler
 * that claimed it reports it parsed, or at once when no handler claimed it.
 */
export class PtyDataDispatch {
  readonly #handlers = new Set<PtyDataHandler>();
  /** Parsed but not yet acknowledged, per id: always below one batch. */
  readonly #parsed = new Map<string, number>();
  readonly #acknowledge: (id: string, chars: number) => void;

  /** `acknowledge` is the adapter's `acknowledgePtyData`. */
  constructor(acknowledge: (id: string, chars: number) => void) {
    this.#acknowledge = acknowledge;
  }

  add(handler: PtyDataHandler): void {
    this.#handlers.add(handler);
  }

  delete(handler: PtyDataHandler): void {
    this.#handlers.delete(handler);
  }

  clear(): void {
    this.#handlers.clear();
    this.#parsed.clear();
  }

  /** Deliver one live `pty:data` chunk. Never replay: a replay was never counted. */
  deliver(detail: PtyDataDetail): void {
    const chars = detail.data.length;
    let parsed: (() => void) | undefined;
    const claim: PtyDataClaim = () => (parsed ??= this.#parsedCallback(detail.id, chars));
    for (const handler of this.#handlers) {
      try {
        handler(detail, claim);
      } catch (error) {
        console.error(`[pty-data] an output handler for ${detail.id} threw:`, error);
        // A claim its handler never handed to xterm would never be called back.
        parsed?.();
      }
    }
    if (!parsed) this.#send(detail.id, chars);
  }

  #parsedCallback(id: string, chars: number): () => void {
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const total = (this.#parsed.get(id) ?? 0) + chars;
      if (total < PTY_ACK_BATCH_CHARS) {
        this.#parsed.set(id, total);
        return;
      }
      this.#parsed.delete(id);
      this.#send(id, total);
    };
  }

  /** Runs inside xterm's write loop, where a throw would stop its parse. */
  #send(id: string, chars: number): void {
    if (chars <= 0) return;
    try {
      this.#acknowledge(id, chars);
    } catch (error) {
      console.error(`[pty-data] acknowledging ${id} failed:`, error);
    }
  }
}
