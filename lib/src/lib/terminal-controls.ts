export interface StripTerminalControlsOptions {
  /** Replace cursor-moving or erasing controls with newlines, except SGR and
   * charset designators, so line/word consumers never weld disjoint screen text.
   * A trailing synthetic boundary is not a real line break; see
   * `detectReturnedShellPrompt` and `docs/specs/terminal-state.md`. */
  boundaries?: boolean;
}

/** Remove presentation controls safely from slices that may start or end
 * mid-sequence. Shared by resume-hint and returned-prompt detection. */
export function stripTerminalControls(input: string, options: StripTerminalControlsOptions = {}): string {
  const boundary = options.boundaries ? '\n' : '';
  const csi = options.boundaries
    ? (match: string) => (match.endsWith('m') ? '' : '\n')
    : () => '';
  return (
    input
      // OSC/DCS/SOS/PM/APC strings. Try 7-bit ST before bare ESC so the
      // terminator is consumed whole and any following sequence remains.
      .replace(/\x1b\][\s\S]*?(?:\x07|[\x18\x1a\x9c]|\x1b\\|(?=\x1b))/g, '')
      .replace(/\x1b[PX^_][\s\S]*?(?:[\x18\x1a\x9c]|\x1b\\|(?=\x1b))/g, '')
      // An unterminated string swallows the tail; stripping only its introducer
      // would promote the payload to visible text.
      .replace(/\x1b[\]PX^_][\s\S]*$/, '')
      // CSI.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, csi)
      // An incomplete trailing CSI swallows its parameters rather than
      // promoting them to visible text.
      .replace(/\x1b\[[0-?]*[ -/]*$/, boundary)
      // Charset designators (G0–G3): no cursor movement, no erase, so like SGR
      // they leave the text either side genuinely contiguous.
      .replace(/\x1b[()*+][A-Za-z0-9]/g, '')
      // Remaining ESC sequences use the full Fp/Fe/Fs/nF final-byte range;
      // matching only the introducer would leak finals such as `7`, `8`, or `c`.
      .replace(/\x1b[ -/]*[0-~]/g, boundary)
      // Backspace, VT and FF move the cursor, so they seam two regions the same
      // way a CSI move does — give them the same boundary when asked.
      .replace(/[\x08\x0b\x0c]/g, boundary)
      // Preserve LF/CR/TAB as text boundaries; discard other C0/C1 controls.
      .replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '')
  );
}
