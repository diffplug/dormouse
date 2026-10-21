import { quotePosixArg, quoteWindowsPortableArg, type ShellCommandKind } from 'dor/commands/shell-quote';
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
  // back to `dor`'s single-quote wrapping, which keeps `'` and `\` outside
  // the quotes so fish parses it too. `pasteFilePaths` refuses such a path
  // before it gets here; this keeps the function total.
  if (POSIX_NEEDS_QUOTES.test(input)) return quotePosixArg(input);
  return input.replace(POSIX_UNSAFE, '\\$1');
}

/** Escape a pasted path for its Session's shell family, or null when it has no
 * safe form (mouse-and-clipboard.md §8.6). A cmd or PowerShell Session may be
 * running another of cmd, Windows PowerShell, and pwsh by the time the path
 * lands, so both get the form each of them reads as the same literal. */
export function shellEscapePath(input: string, shellKind: ShellCommandKind): string | null {
  return shellKind === 'posix' ? shellEscapePosix(input) : quoteWindowsPortableArg(input);
}
