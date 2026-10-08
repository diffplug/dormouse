import type { TerminalProtocolEvent } from './terminal-protocol';

/**
 * Which of a PTY's OSC 367 `open` requests its owner forwards
 * (`docs/specs/dor-tool.md` -> OSC 367): only those made during the run the
 * host itself launched there. Dormouse arms it as it types a command line into
 * the PTY (`WritePtyOptions.launch`); the next command start is that run if the
 * shell reports the same line, and any start ends the launch. The run lasts
 * until the next start, finish, or prompt.
 *
 * Output can only end a run here, never begin one: nothing a program prints
 * arms the latch, so a forged shell-integration start admits nothing once the
 * launched run is over. The reported line only narrows; it never vouches.
 */
export class ToolLaunchLatch {
  /** The command line the host typed, until the next start. */
  #launched: string | null = null;
  /** The line the shell staged for its next start (`OSC 633;E`). */
  #line: string | null = null;
  #running = false;

  /** The host typed `typed` into this PTY, its Enter included or not. */
  arm(typed: string): void {
    this.#launched = typed.replace(/\r$/, '');
    this.#running = false;
  }

  /** `events` without the `open` requests the launched run did not make,
   *  folding its boundaries in stream order. */
  admit(events: readonly TerminalProtocolEvent[]): TerminalProtocolEvent[] {
    return events.filter((event) => {
      if (event.kind === 'toolOpen') return this.#running;
      if (event.kind !== 'semantic') return true;
      switch (event.event.type) {
        case 'commandLine':
          this.#line = event.event.commandLine;
          break;
        case 'commandStart':
          this.#running = this.#launched !== null && this.#line === this.#launched;
          this.#launched = null;
          this.#line = null;
          break;
        case 'commandFinish':
          this.#running = false;
          break;
        // The prompt the typed line was waiting on can still be drawing, so a
        // prompt ends a run but never the launch.
        case 'promptStart':
        case 'promptEnd':
          this.#running = false;
          this.#line = null;
          break;
      }
      return true;
    });
  }
}
