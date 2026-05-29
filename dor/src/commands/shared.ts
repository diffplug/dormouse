import { SocketControlClient } from '../control-client.js';
import type {
  CliOptions,
  CliResult,
  ControlClient,
  DorCommandContext,
  IdFormat,
  ParseResult,
} from './types.js';

export const stringParser = (input: string): string => input;

export function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '' };
}

export function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `Error: ${message}\n` };
}

export function isIdFormat(value: string): value is IdFormat {
  return value === 'refs' || value === 'uuids' || value === 'both';
}

export function parseIdFormat(value: string): IdFormat {
  if (isIdFormat(value)) return value;
  throw new SyntaxError(`invalid --id-format '${value}'`);
}

export function resolveControlClient(options: CliOptions): ParseResult<ControlClient> {
  if (options.client) return { ok: true, value: options.client };

  const env = options.env ?? {};
  const socketPath = env.DORMOUSE_CONTROL_SOCKET;
  const token = env.DORMOUSE_CONTROL_TOKEN;
  if (!socketPath || !token) {
    return { ok: false, message: 'Dormouse control endpoint is not available in this terminal yet.' };
  }

  return {
    ok: true,
    value: new SocketControlClient({
      socketPath,
      token,
      surfaceId: env.DORMOUSE_SURFACE_ID,
    }),
  };
}

export function renderHandle(handle: { ref: string; id: string }, idFormat: IdFormat): string {
  switch (idFormat) {
    case 'refs':
      return handle.ref;
    case 'uuids':
      return handle.id;
    case 'both':
      return `${handle.ref} ${handle.id}`;
  }
}

export function wantsRefs(idFormat: IdFormat): boolean {
  return idFormat !== 'uuids';
}

export function wantsIds(idFormat: IdFormat): boolean {
  return idFormat !== 'refs';
}

export function writeStdout(context: DorCommandContext, stdout: string): void {
  context.process.stdout.write(stdout);
}

const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argv token for a POSIX shell: left bare when it contains only
 * shell-safe characters, otherwise wrapped in single quotes with embedded
 * single quotes escaped as the standard '\'' sequence. The chosen quoting may
 * differ from how the user originally typed the argument, but the receiving
 * shell re-parses it into the identical token.
 */
function quoteShellArg(arg: string): string {
  if (arg === '') return "''";
  if (SAFE_SHELL_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Join an argv array captured after `--` into a single shell command string,
 * quoting each token so the receiving shell re-parses it into the same argv.
 * Returns undefined when there is no meaningful command (no tokens, or only
 * empty/whitespace tokens). Shared by `dor split` and `dor ensure`.
 */
export function buildShellCommand(args: readonly string[]): string | undefined {
  if (args.join('').trim() === '') return undefined;
  return args.map(quoteShellArg).join(' ');
}
