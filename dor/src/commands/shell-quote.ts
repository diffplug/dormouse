/**
 * Pure, dependency-free shell quoting. The webview (the only layer that knows
 * the target pane's shell) turns a raw argv array into a single command string
 * for that shell. Keep this module free of Node imports so it can be bundled
 * into the browser-side webview as well as the CLI.
 */

export type ShellCommandKind = 'cmd' | 'posix' | 'powershell';

/** C0, DEL, and C1, as a character class body. */
export const CONTROL_CHARACTERS = '\\x00-\\x1f\\x7f-\\x9f';
/** Unicode format characters that reorder or hide the text around them: every
 *  bidi control, the zero-width space and joiners, the word joiner and
 *  invisible operators, and the BOM — the set `boundedPushText` in
 *  `remote-lib-common/src/security/push.ts` drops. A class body, so a printer
 *  can escape the same set. */
export const FORMAT_CHARACTERS = '\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff';
const SHELL_INPUT_CONTROLS = new RegExp(`[${CONTROL_CHARACTERS}]`);
const CONTROL_OR_FORMAT = new RegExp(`[${CONTROL_CHARACTERS}${FORMAT_CHARACTERS}]`);

/** Shell quotes cannot protect bytes that an interactive terminal interprets
 * as editing keys, escape sequences, or line submission before shell parsing.
 * C1 is included: the line editor echoes it, and the echo drives the terminal. */
export function hasShellInputControls(value: string): boolean {
  return SHELL_INPUT_CONTROLS.test(value);
}

/** Text a repo writes into a Tool definition: besides the controls above, any
 *  character that makes the text shown differ from the text run
 *  (`docs/specs/security-local.md` -> Dor Tool configuration). */
export function hasControlOrFormatCharacters(value: string): boolean {
  return CONTROL_OR_FORMAT.test(value);
}

/** How a refusal names what `hasControlOrFormatCharacters` finds. */
export const CONTROL_OR_FORMAT_TEXT = 'terminal control characters or invisible formatting characters';

const POSIX_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
// No `,` or `@`, unlike the posix set: PowerShell's argument mode reads a comma
// as the array operator (`cat a,b.txt` passes two arguments), while an initial
// `@` starts splatting / array / hashtable syntax. cmd.exe also treats `,` as an
// argument separator, so the shared set conservatively quotes both characters.
const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_+=:./\\-]+$/;

export function shellCommandKind(shell: string | undefined, platformString: string): ShellCommandKind {
  const normalizedShell = (shell ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!normalizedShell && /win/i.test(platformString)) return 'cmd';
  if (normalizedShell === 'cmd.exe' || normalizedShell === 'cmd') return 'cmd';
  if (normalizedShell === 'powershell.exe' || normalizedShell === 'powershell' || normalizedShell === 'pwsh.exe' || normalizedShell === 'pwsh') {
    return 'powershell';
  }
  return 'posix';
}

export function buildShellCommandForKind(kind: ShellCommandKind, args: readonly string[]): string {
  switch (kind) {
    case 'cmd':
      return args.map(quoteCmdArg).join(' ');
    case 'powershell':
      return quotePowerShellCommand(args);
    case 'posix':
      return args.map(quotePosixArg).join(' ');
  }
}

/** Single-quoted, with each `'` and `\` stepped outside the quotes: fish reads
 *  `\'` and `\\` as escapes even inside single quotes, so `'a\'` would not close.
 *  Also what the webview's paste path uses for a path backslash-escaping cannot
 *  carry (`shellEscapePosix`). */
export function quotePosixArg(arg: string): string {
  if (arg === '') return "''";
  if (POSIX_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/['\\]/g, (c) => `'\\${c}'`)}'`;
}

function quotePowerShellCommand(args: readonly string[]): string {
  const [command, ...rest] = args;
  if (command === undefined) return '';
  const quotedCommand = quotePowerShellArg(command);
  const commandPrefix = quotedCommand.startsWith("'") ? '& ' : '';
  return `${commandPrefix}${[quotedCommand, ...rest.map(quotePowerShellArg)].join(' ')}`;
}

/** Every character PowerShell reads as a single quote: `'` and U+2018–U+201B.
 *  `standalone/sidecar/clipboard-ops.js` and `standalone/scripts/clean-dev-sidecar.mjs`
 *  keep copies; neither can import this module. */
const POWERSHELL_SINGLE_QUOTES = /['\u2018-\u201b]/g;

/** PowerShell single-quoted strings are literal — no `$(...)` subexpression and
 *  no `$name` interpolation — so this is also what the webview's drop/paste
 *  path uses to quote a file path for a PowerShell pane (`shellEscapePath`).
 *  Each quote character is doubled, as `EscapeSingleQuotedStringContent` does. */
export function quotePowerShellArg(arg: string): string {
  if (arg === '') return "''";
  if (WINDOWS_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(POWERSHELL_SINGLE_QUOTES, (c) => c + c)}'`;
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  const escaped = arg
    .replace(/[%]/g, '%%')
    .replace(/([&|<>()^"])/g, '^$1');
  if (WINDOWS_SAFE_ARG.test(arg)) return escaped;
  return `"${escaped}"`;
}
