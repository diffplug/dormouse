export interface StripTerminalControlsOptions {
  /**
   * Replace every control that moves the cursor or erases — with SGR and charset
   * designators exempted — with a newline instead of deleting it.
   *
   * Deleting them welds together text that was never adjacent on screen: a
   * redraw like `<uuid>\x1b[K\x1b[1;1Hcodex resume ...` collapses to
   * `<uuid>codex resume ...`, and a greedy id pattern then swallows across the
   * seam — observed in the wild as a captured `claude --resume <uuid>codex`.
   * Cursor moves are the obvious case, but erasures are discontinuities too:
   * `\x1b[2K` means the text before it on that line is gone, so what follows
   * belongs to a different region.
   *
   * CSI is the common case but not the only one: `ESC M` (RI) is how a TUI
   * scrolls up, `ESC 7`/`ESC 8` bracket a redraw, `ESC c` resets outright, and
   * VT/FF move the cursor down — each welds exactly the same way. So the rule is
   * inverted: *every* sequence gets a boundary except the two classes known to
   * neither move nor erase, SGR (`m`) and charset designators, where the text
   * either side really is contiguous.
   *
   * Any consumer that reads the result as *lines* or *words* rather than as a
   * blob wants this: `detectResumeCommand` (`resume-patterns.ts`) and the
   * keystroke-fallback prompt detector (`terminal-state-store.ts`) both do.
   *
   * Note for line-oriented callers: a boundary is not a real line break, so a
   * trailing one leaves an empty final line. `detectReturnedShellPrompt` has to
   * tell the two apart — see its trailing-boundary trim, and
   * `docs/specs/terminal-state.md`.
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
  const boundary = options.boundaries ? '\n' : '';
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
      // CSI.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, csi)
      // A CSI the input was cut off in the middle of, which by definition can
      // only be the last thing in it. Without this the catch-all below would
      // match its `\x1b[` introducer alone and promote the parameters to text —
      // a tail cut at `...\x1b[38;5` would read as `...38;5`.
      .replace(/\x1b\[[0-?]*[ -/]*$/, boundary)
      // Charset designators (G0–G3): no cursor movement, no erase, so like SGR
      // they leave the text either side genuinely contiguous.
      .replace(/\x1b[()*+][A-Za-z0-9]/g, '')
      // Every remaining escape sequence — ESC, zero or more intermediates
      // (0x20-0x2f), one final byte (0x30-0x7e). This is the whole Fp/Fe/Fs/nF
      // space, not just the Fe range: `ESC 7`/`ESC 8` (DECSC/DECRC, 0x37/0x38)
      // and `ESC c` (RIS, 0x63) fall outside it, and matching only the
      // introducer would leak their final byte into the text as a digit or a
      // letter — straight into a greedy id capture.
      .replace(/\x1b[ -/]*[0-~]/g, boundary)
      // Backspace, VT and FF move the cursor, so they seam two regions the same
      // way a CSI move does — give them the same boundary when asked.
      .replace(/[\x08\x0b\x0c]/g, boundary)
      // Preserve LF/CR/TAB as text boundaries; discard other C0/C1 controls.
      .replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '')
  );
}
