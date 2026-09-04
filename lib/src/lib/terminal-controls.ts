export interface StripTerminalControlsOptions {
  /** Replace cursor-moving or erasing controls with newlines, except SGR and
   * charset designators, so line/word consumers never weld disjoint screen text.
   * A trailing synthetic boundary is not a real line break; see
   * `detectReturnedShellPrompt` and `docs/specs/terminal-state.md`. */
  boundaries?: boolean;
}

type TerminalControlStreamState = 'ground' | 'escape' | 'osc' | 'string' | 'stringEscape';

// What opens a string control: a two-byte `ESC ] P X ^ _`, or a C1 introducer —
// DCS (0x90), SOS (0x98), OSC (0x9d), PM (0x9e), APC (0x9f). Matching the ESC
// form whole rather than bare ESC keeps SGR-dense output on one scan per chunk.
const STREAM_INTRODUCER = /\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f]/;
const STREAM_INTRODUCER_SCAN = new RegExp(STREAM_INTRODUCER.source, 'g');
// BEL ends an OSC but is payload inside DCS/SOS/PM/APC, so the two states scan
// for different sets; CAN, SUB and the C1 ST abort either.
const OSC_END_SCAN = /[\x07\x18\x1a\x1b\x9c]/g;
const STRING_END_SCAN = /[\x18\x1a\x1b\x9c]/g;

/**
 * Removes OSC/DCS/SOS/PM/APC strings without promoting payload bytes to text
 * when a PTY read ends in the middle of one. The returned stream deliberately
 * keeps every other control for `stripTerminalControls` to interpret with its
 * boundary option at the point of use.
 *
 * Runs on every byte of every pane's output, so it emits whole runs between
 * introducers rather than stepping per character, and returns a chunk with no
 * introducer untouched.
 */
export class TerminalControlStreamFilter {
  private state: TerminalControlStreamState = 'ground';

  process(input: string): string {
    if (this.state === 'ground' && !input.endsWith('\x1b') && !STREAM_INTRODUCER.test(input)) {
      return input;
    }

    let output = '';
    let i = 0;

    while (i < input.length) {
      switch (this.state) {
        case 'ground': {
          STREAM_INTRODUCER_SCAN.lastIndex = i;
          const match = STREAM_INTRODUCER_SCAN.exec(input);
          if (!match) {
            // A chunk ending in bare ESC may be a string introducer split
            // across PTY reads, so hold the byte rather than emitting it.
            const held = input.endsWith('\x1b') ? 1 : 0;
            if (held) this.state = 'escape';
            output += input.slice(i, input.length - held);
            i = input.length;
            break;
          }
          output += input.slice(i, match.index);
          const introducer = match[0];
          const opener = introducer.length === 2 ? introducer[1] : introducer;
          this.state = opener === ']' || opener === '\x9d' ? 'osc' : 'string';
          i = match.index + introducer.length;
          break;
        }

        case 'escape': {
          const char = input[i];
          if (char === ']') {
            this.state = 'osc';
            i += 1;
          } else if (char === 'P' || char === 'X' || char === '^' || char === '_') {
            this.state = 'string';
            i += 1;
          } else {
            // It was an ordinary ESC sequence. Preserve the introducer and
            // re-read this byte in ground state so the stateless stripper sees
            // the complete sequence, even when ESC ended the previous chunk.
            output += '\x1b';
            this.state = 'ground';
          }
          break;
        }

        case 'osc':
        case 'string': {
          const scan = this.state === 'osc' ? OSC_END_SCAN : STRING_END_SCAN;
          scan.lastIndex = i;
          const match = scan.exec(input);
          if (!match) {
            i = input.length;
            break;
          }
          // The payload is dropped either way; only ESC needs a follow-up byte
          // to tell an ST terminator from a string-cancelling new sequence.
          this.state = input.charCodeAt(match.index) === 0x1b ? 'stringEscape' : 'ground';
          i = match.index + 1;
          break;
        }

        case 'stringEscape': {
          if (input[i] === '\\') {
            this.state = 'ground';
            i += 1;
          } else {
            // A bare ESC cancels the string and starts a new escape sequence.
            this.state = 'escape';
          }
          break;
        }
      }
    }

    return output;
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
