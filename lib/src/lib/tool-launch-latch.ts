import type { TerminalProtocolEvent } from './terminal-protocol';

/**
 * Which of a PTY's OSC 367 `open` requests its owner forwards
 * (`docs/specs/dor-tool.md` -> OSC 367): only those made during the run the
 * host itself launched there. Dormouse arms it as it types a command line
 * into the PTY (`WritePtyOptions.launch`); the first command start after that
 * is the launched run, and the next start, finish, or prompt ends it for good.
 *
 * Output can only end a run here, never begin one: nothing a program prints
 * arms the latch, so a forged shell-integration start — whatever command line
 * it reports — admits nothing once the launched run is over.
 */
export class ToolLaunchLatch {
  #state: 'idle' | 'launched' | 'running' = 'idle';

  /** The host typed a command line into this PTY. */
  arm(): void {
    this.#state = 'launched';
  }

  /** `events` without the `open` requests the launched run did not make,
   *  folding its boundaries in stream order. */
  admit(events: readonly TerminalProtocolEvent[]): TerminalProtocolEvent[] {
    return events.filter((event) => {
      if (event.kind === 'toolOpen') return this.#state === 'running';
      if (event.kind !== 'semantic') return true;
      switch (event.event.type) {
        case 'commandStart':
          this.#state = this.#state === 'launched' ? 'running' : 'idle';
          break;
        // The prompt the typed line was waiting on can still be drawing.
        case 'commandFinish':
        case 'promptStart':
        case 'promptEnd':
          if (this.#state === 'running') this.#state = 'idle';
          break;
      }
      return true;
    });
  }
}
