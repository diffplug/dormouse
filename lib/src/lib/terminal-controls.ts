export interface StripTerminalControlsOptions {
  /** Replace cursor-moving or erasing controls with newlines, except SGR and
   * charset designators, so line/word consumers never weld disjoint screen text.
   * A trailing synthetic boundary is not a real line break; see
   * `detectReturnedShellPrompt` and `docs/specs/terminal-state.md`. */
  boundaries?: boolean;
}

type TerminalControlStreamState =
  | 'ground'
  | 'escape'
  | 'osc'
  | 'string'
  | 'oscEscape'
  | 'stringEscape';

/**
 * Removes OSC/DCS/SOS/PM/APC strings without promoting payload bytes to text
 * when a PTY read ends in the middle of one. The returned stream deliberately
 * keeps every other control for `stripTerminalControls` to interpret with its
 * boundary option at the point of use.
 */
export class TerminalControlStreamFilter {
  private state: TerminalControlStreamState = 'ground';

  process(input: string): string {
    let output = '';

    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      const code = input.charCodeAt(i);

      switch (this.state) {
        case 'ground':
          if (char === '\x1b') {
            this.state = 'escape';
          } else if (code === 0x9d) {
            this.state = 'osc';
          } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            this.state = 'string';
          } else {
            output += char;
          }
          break;

        case 'escape':
          if (char === ']') {
            this.state = 'osc';
          } else if (char === 'P' || char === 'X' || char === '^' || char === '_') {
            this.state = 'string';
          } else {
            // It was an ordinary ESC sequence. Preserve the introducer and
            // re-read this byte in ground state so the stateless stripper sees
            // the complete sequence, even when ESC ended the previous chunk.
            output += '\x1b';
            this.state = 'ground';
            i -= 1;
          }
          break;

        case 'osc':
          if (char === '\x07' || char === '\x18' || char === '\x1a' || code === 0x9c) {
            this.state = 'ground';
          } else if (char === '\x1b') {
            this.state = 'oscEscape';
          }
          break;

        case 'string':
          if (char === '\x18' || char === '\x1a' || code === 0x9c) {
            this.state = 'ground';
          } else if (char === '\x1b') {
            this.state = 'stringEscape';
          }
          break;

        case 'oscEscape':
        case 'stringEscape':
          if (char === '\\') {
            this.state = 'ground';
          } else {
            // A bare ESC cancels the string and starts a new escape sequence.
            this.state = 'escape';
            i -= 1;
          }
          break;
      }
    }

    return output;
  }

  reset(): void {
    this.state = 'ground';
  }
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
