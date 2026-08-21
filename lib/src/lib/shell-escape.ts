import { quotePowerShellArg, shellCommandKind, type ShellCommandKind } from 'dor/commands/shell-quote';
import { PLATFORM_STRING } from './platform';
import { getDefaultShellOpts } from './shell-defaults';

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

// cmd.exe only: it performs no expansion inside double quotes, so wrapping is
// enough. PowerShell's double-quoted strings *are* expandable, which is why it
// gets `quotePowerShellArg` instead — see `shellEscapePath`.
export function shellEscapeWindows(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

/**
 * Which parser will read the staged line. The selected shell decides — the host
 * platform is only the fallback for when nothing has been selected yet, because
 * a Windows host runs PowerShell, Git Bash, and WSL panes as readily as cmd.
 *
 * This mirrors `dor`'s quoting (docs/specs/dor-cli.md): the app-global default
 * shell stands in for the pane's shell, which is not tracked per-session. The
 * platform fallback is `shellCommandKind`'s own — an unset shell classifies as
 * `cmd` on Windows and `posix` everywhere else — so the rule lives in one place.
 */
function paneShellKind(): ShellCommandKind {
  return shellCommandKind(getDefaultShellOpts()?.shell, PLATFORM_STRING);
}

/**
 * Escape a filesystem path for the pane's shell, for the drop/paste path.
 *
 * Quoting for the wrong parser is a code-execution bug, not a cosmetic one: a
 * cmd-style `"$(calc.exe).txt"` staged in a PowerShell pane runs the
 * subexpression the moment the user presses Enter, and pressing Enter is the
 * whole reason they dropped the file in (dormouse#430).
 */
export function shellEscapePath(input: string): string {
  switch (paneShellKind()) {
    case 'powershell':
      return quotePowerShellArg(input);
    case 'cmd':
      return shellEscapeWindows(input);
    case 'posix':
      return shellEscapePosix(input);
  }
}
