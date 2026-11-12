import type {
  CliOptions,
  CliResult,
  ControlClient,
  DorCommandContext,
  ParseResult,
} from './types.js';
import { errorLine } from './terminal-text.js';

export { errorLine, printable, renderJson, renderPrintableJson } from './terminal-text.js';

export const stringParser = (input: string): string => input;

/** Thrown by a flag parser whose flag got an empty value; `cli-core.ts` reports
 *  it as `--flag requires a value`. */
export class MissingValueError extends Error {}

/** Flag parser for `--cwd`: an empty value (`--cwd "$UNSET"`) is missing, never
 *  the caller's directory, so a command never silently runs somewhere else. */
export function cwdParser(input: string): string {
  if (input === '') throw new MissingValueError();
  return input;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `${errorLine(message)}\n` };
}

/** Flag parser for positive integers (`--lines`, `--port`, `--timeout`). */
export function parsePositiveInt(input: string, flag: string, max = Number.POSITIVE_INFINITY): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new SyntaxError(`invalid ${flag} '${input}'`);
  }
  return value;
}

/** Flag parser for non-negative integers (`--index`, 0-based). */
export function parseNonNegativeInt(input: string, flag: string): number {
  const value = Number(input);
  if (input.trim() === '' || !Number.isInteger(value) || value < 0) {
    throw new SyntaxError(`invalid ${flag} '${input}'`);
  }
  return value;
}


export interface PreDelimiterArgSpec {
  /** Boolean flags, bare or as `--name=value` for stricli to parse. */
  readonly booleans: ReadonlySet<string>;
  /** Flags consuming the next argument. */
  readonly valued: ReadonlySet<string>;
  /** `'reject'` fails on the first non-flag argument; `'collect'` returns them all. */
  readonly positionals: 'collect' | 'reject';
}

/**
 * The argv-head shape check `dor ensure` and `dor tool` share. stricli cannot
 * express "only these flags may precede `--`", so `cli-core.ts` runs this before it
 * parses; each command supplies its own flag sets and keeps them beside its
 * `parameters.flags`.
 */
export function scanPreDelimiterArgs(head: readonly string[], spec: PreDelimiterArgSpec): ParseResult<string[]> {
  const positionals: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (spec.booleans.has(arg)) continue;
    // stricli also takes `--flag=value`, a boolean's value included.
    const equals = arg.indexOf('=');
    const name = arg.slice(0, equals);
    if (arg.startsWith('--') && equals > 0 && (spec.valued.has(name) || spec.booleans.has(name))) {
      continue;
    }
    if (spec.valued.has(arg)) {
      const value = head[index + 1];
      if (value === undefined) return { ok: false, message: `${arg} requires a value` };
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, message: `unknown option '${arg}'` };
    if (spec.positionals === 'reject') return { ok: false, message: `unexpected argument '${arg}' before --` };
    positionals.push(arg);
  }
  return { ok: true, value: positionals };
}

function resolveControlClient(options: CliOptions, timeoutMs?: number): ParseResult<ControlClient> {
  if (options.client) return { ok: true, value: options.client };

  const env = options.env ?? {};
  const socketPath = env.DORMOUSE_CONTROL_SOCKET;
  const token = env.DORMOUSE_CONTROL_TOKEN;
  if (!socketPath || !token) {
    return { ok: false, message: 'Dormouse control endpoint is not available in this terminal yet.' };
  }

  return {
    ok: true,
    value: options.host.connect({
      socketPath,
      token,
      surfaceId: env.DORMOUSE_SURFACE_ID,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  };
}

// `timeoutMs` overrides the client's default request timeout for commands that
// intentionally block the host (e.g. `dor ensure --restart` waits for a server
// to die and respawn). Ignored when a client is injected (tests).
export function requireControlClient(options: CliOptions, timeoutMs?: number): ControlClient | Error {
  const result = resolveControlClient(options, timeoutMs);
  return result.ok ? result.value : new Error(result.message);
}

/** The `--workspace <ref>` flag every action command carries, defined once so
 *  its wording cannot drift (`docs/specs/dor-cli.md` → "Handle Model"). */
export const workspaceFlag = {
  kind: 'parsed',
  parse: stringParser,
  brief: "Workspace to act in, instead of the caller's.",
  optional: true,
  placeholder: 'ref',
} as const;

/** The `workspace` field of a request, present only when the flag was given. */
export function workspaceParam(workspace: string | undefined): { workspace?: string } {
  return workspace === undefined ? {} : { workspace };
}

/** The `--focus` flag every Surface-producing command carries; `--focus=false`
 *  states the default off (`docs/specs/dor-cli.md` → "Focus intent"). */
export const focusFlag = {
  kind: 'boolean',
  brief: 'Focus the created or reused Surface (default: only when typed alone at a prompt).',
  optional: true,
  withNegated: false,
} as const;

/** The `focus` field of a request, present only when the flag was given, so
 *  the host can apply its default. */
export function focusParam(focus: boolean | undefined): { focus?: boolean } {
  return focus === undefined ? {} : { focus };
}

/** The focus paragraph of each Surface-producing command's help. */
export function focusHelp({ minimize }: { minimize: boolean }): string {
  return 'Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent\'s or a script\'s invocation leaves focus where it is. --focus or --focus=false decides either way.'
    + (minimize ? ' --minimize turns the default off, and --focus with --minimize is an error.' : '');
}

/** An explicit `--focus` cannot apply to a Surface `--minimize` hides. */
export function focusMinimizeConflict(flags: { readonly focus?: boolean; readonly minimize?: boolean }): Error | undefined {
  return flags.focus === true && flags.minimize === true ? new Error('--focus and --minimize are mutually exclusive') : undefined;
}

export function writeStdout(context: DorCommandContext, stdout: string): void {
  context.process.stdout.write(stdout);
}

// stderr is the explain-what-happened channel regardless of exit status, so a
// command may write it on a *successful* run too (`dor await`'s narrative).
export function writeStderr(context: DorCommandContext, stderr: string): void {
  context.process.stderr.write(stderr);
}

// Git Bash exports PWD as a POSIX path (`/c/Users/...`). On Windows, resolvePath
// reads the leading `/c` as a folder under the current drive's root and mangles it
// to `C:\c\Users\...`, which then matches no surface. Fold the MSYS drive form to a
// native Windows drive first, including a drive root, which Git Bash exports as a
// bare `/c`. No-op off win32 and for paths that already carry a drive letter (e.g.
// `C:/Users/...`, which some MSYS builds export instead).
export function msysToWindowsCwd(pwd: string, platform: string): string {
  if (platform !== 'win32') return pwd;
  const match = pwd.match(/^\/([A-Za-z])(?:\/(.*))?$/);
  return match ? `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}` : pwd;
}

// The host has no idea where `dor` was launched, so the caller's directory must
// travel in the request. Prefer the shell's PWD (injectable, matches what the
// user sees) and fall back to the process cwd. resolvePath canonicalizes both the
// default and a relative/absolute path into one absolute path the host can key on.
// Every command that sends a caller cwd resolves it here, so none skips the
// MSYS fold above.
export function callerWorkingDirectory(flag: string | undefined, { env, host }: CliOptions): string {
  const base = msysToWindowsCwd(env?.PWD ?? host.cwd(), host.platform);
  return host.resolvePath(base, flag ?? '.');
}

/** `callerWorkingDirectory` for a command Dormouse launches there. A `--cwd`
 *  naming no directory fails here: the PTY host would start the shell in the
 *  home directory instead, and the command would run there. */
export function launchDirectory(flag: string | undefined, options: CliOptions): string | Error {
  const cwd = callerWorkingDirectory(flag, options);
  return flag === undefined || options.host.isDirectory(cwd) ? cwd : new Error(`directory '${cwd}' does not exist`);
}

/** The help both browser commands give their `dor-diagnostics` intercept. */
export function diagnosticsHelp(command: string): string {
  return `and dor-diagnostics to print, as JSON, what the pane and the host know about
its stream — for a pane that froze, or never showed its page:
  ${command} --surface surface:3 dor-diagnostics`;
}
