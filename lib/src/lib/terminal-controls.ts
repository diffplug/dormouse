export interface StripTerminalControlsOptions {
  /**
   * Replace cursor-*moving* sequences with a newline instead of deleting them.
   *
   * Deleting them welds together text that was never adjacent on screen: a
   * redraw like `<uuid>\x1b[K\x1b[1;1Hcodex resume ...` collapses to
   * `<uuid>codex resume ...`, and a greedy id pattern then swallows across the
   * seam — observed in the wild as a captured `claude --resume <uuid>codex`.
   * Any consumer that reads the result as *words* rather than as a blob wants
   * this. SGR (`m`) is exempt: colour changes do not move the cursor, so the
   * text either side of one really is contiguous.
   */
  boundaries?: boolean;
}

/**
 * Remove terminal presentation controls, leaving the text a user would see.
 *
 * Shared by every consumer that interprets raw PTY output as *content* rather
 * than as a stream: resume-hint detection (`resume-patterns.ts`) and the
 * keystroke-fallback prompt detector (`terminal-state-store.ts`). Both read a
 * tail slice of a buffer, so both are routinely handed input that starts or
 * ends mid-sequence — and a payload that leaks through reads as terminal output
 * in a place where that decides whether a command is offered or a shell is
 * called idle. One implementation so a hardening step can't reach only one of
 * them.
 */
export function stripTerminalControls(input: string, options: StripTerminalControlsOptions = {}): string {
  const csi = options.boundaries
    ? (match: string) => (match.endsWith('m') ? '' : '\n')
    : () => '';
  return (
    input
      // String controls: OSC (BEL or ST terminated); DCS/SOS/PM/APC (ST
      // terminated). ST is `\x1b\\` or its 8-bit form `\x9c`; xterm also ends a
      // string control on CAN/SUB (abort) or a bare ESC, so the text behind one
      // is visible output, not payload. `\x1b\\` must be tried before the
      // bare-ESC lookahead so a 7-bit ST is consumed whole; the lookahead
      // leaves a following sequence for the rules below.
      .replace(/\x1b\][\s\S]*?(?:\x07|[\x18\x1a\x9c]|\x1b\\|(?=\x1b))/g, '')
      .replace(/\x1b[PX^_][\s\S]*?(?:[\x18\x1a\x9c]|\x1b\\|(?=\x1b))/g, '')
      // An UNterminated string control (a chunk or trim cut mid-sequence)
      // swallows the rest of the input. Without this the ESC catch-all below
      // would strip only the introducer and promote the payload — an OSC window
      // title, say — into text that reads as terminal output. Nothing before the
      // cut is lost: the terminated forms above have already been removed, so
      // whatever remains really is an unclosed payload.
      .replace(/\x1b[\]PX^_][\s\S]*$/, '')
      // CSI, charset designators, and remaining two-byte ESC sequences.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, csi)
      .replace(/\x1b[()][A-Za-z0-9]/g, '')
      .replace(/\x1b[@-_]/g, '')
      // Backspace moves the cursor, so it seams two regions the same way a CSI
      // move does — give it the same boundary when the caller asked for them.
      .replace(/\x08/g, options.boundaries ? '\n' : '')
      // Preserve LF/CR/TAB as text boundaries; discard other C0/C1 controls.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  );
}
