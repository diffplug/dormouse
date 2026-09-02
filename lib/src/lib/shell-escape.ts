import { quotePowerShellArg, type ShellCommandKind } from 'dor/commands/shell-quote';
import { POSIX_ESCAPABLE } from './posix-escape';

// Matches macOS Terminal's drag-and-drop format: backslash-escape each shell
// metacharacter instead of wrapping in quotes. TUIs like `claude` recognize
// backslash-escaped tokens as filesystem paths where a single-quoted whole
// path gets treated as opaque pasted text.
const POSIX_UNSAFE = new RegExp(`(${POSIX_ESCAPABLE.source})`, 'g');
const POSIX_NEEDS_QUOTES = /[\n\r]/;

export function shellEscapePosix(input: string): string {
  if (input === '') return "''";
  // Newline/CR cannot round-trip through backslash-escape: bash reads
  // `\<newline>` as a line continuation and *swallows* both the backslash
  // and the newline, corrupting filenames that legally contain them. Fall
  // back to single-quote wrapping for these, using the '\'' idiom to
  // embed literal single quotes.
  if (POSIX_NEEDS_QUOTES.test(input)) {
    return `'${input.replace(/'/g, `'\\''`)}'`;
  }
  return input.replace(POSIX_UNSAFE, '\\$1');
}

// cmd.exe only: wrapping keeps whitespace and command separators in one token,
// and `$` / `$(...)` are inert in this parser. cmd's own `%NAME%` expansion (and
// `!NAME!` under delayed expansion) is unchanged. PowerShell's double-quoted
// strings are expandable in a different, dangerous way, so it gets a literal
// single-quoted string instead — see `shellEscapePath`.
export function shellEscapeWindows(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

/** Escape a pasted path for its Session's captured parser. Dispatching by OS
 * alone is unsafe; see mouse-and-clipboard.md §8.6. */
export function shellEscapePath(input: string, shellKind: ShellCommandKind): string {
  switch (shellKind) {
    case 'powershell':
      return quotePowerShellArg(input);
    case 'cmd':
      return shellEscapeWindows(input);
    case 'posix':
      return shellEscapePosix(input);
  }
}
