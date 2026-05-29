import { IS_MAC, IS_WINDOWS } from './platform';

// Matches macOS Terminal's drag-and-drop format: backslash-escape each shell
// metacharacter instead of wrapping in quotes. TUIs like `claude` recognize
// backslash-escaped tokens as filesystem paths where a single-quoted whole
// path gets treated as opaque pasted text.
const POSIX_UNSAFE = /([ \t!"#$&'()*;<>?[\\\]`{|}~])/g;
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

export function shellEscapeWindows(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

export function shellEscapePath(input: string): string {
  return !IS_MAC && IS_WINDOWS ? shellEscapeWindows(input) : shellEscapePosix(input);
}
