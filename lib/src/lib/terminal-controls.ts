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
export function stripTerminalControls(input: string): string {
  return (
    input
      // String controls: OSC (BEL or ST terminated); DCS/SOS/PM/APC (ST
      // terminated). ST is `\x1b\\` or its 8-bit form `\x9c`.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)/g, '')
      .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c)/g, '')
      // An UNterminated string control (a chunk or trim cut mid-sequence)
      // swallows the rest of the input. Without this the ESC catch-all below
      // would strip only the introducer and promote the payload — an OSC window
      // title, say — into text that reads as terminal output. Nothing before the
      // cut is lost: the terminated forms above have already been removed, so
      // whatever remains really is an unclosed payload.
      .replace(/\x1b[\]PX^_][\s\S]*$/, '')
      // CSI, charset designators, and remaining two-byte ESC sequences.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][A-Za-z0-9]/g, '')
      .replace(/\x1b[@-_]/g, '')
      // Preserve LF/CR/TAB as text boundaries; discard other C0/C1 controls.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  );
}
