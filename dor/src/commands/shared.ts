import { resolve as resolvePath } from 'node:path';
import { SocketControlClient } from '../control-client.js';
import type {
  CliEnv,
  CliOptions,
  CliResult,
  ControlClient,
  DorCommandContext,
  IdFormat,
  ParseResult,
} from './types.js';

export const stringParser = (input: string): string => input;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `Error: ${message}\n` };
}

export function renderJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function isIdFormat(value: string): value is IdFormat {
  return value === 'refs' || value === 'ids' || value === 'both';
}

export function parseIdFormat(value: string): IdFormat {
  if (isIdFormat(value)) return value;
  if (value === 'uuids') return 'ids';
  throw new SyntaxError(`invalid --id-format '${value}'`);
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
    value: new SocketControlClient({
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

export function renderHandle(handle: { ref: string; id: string }, idFormat: IdFormat): string {
  switch (idFormat) {
    case 'refs':
      return handle.ref;
    case 'ids':
      return handle.id;
    case 'both':
      return `${handle.ref} ${handle.id}`;
  }
}

export function writeStdout(context: DorCommandContext, stdout: string): void {
  context.process.stdout.write(stdout);
}

// Git Bash exports PWD as a POSIX path (`/c/Users/...`). On Windows, resolvePath
// reads the leading `/c` as a folder under the current drive's root and mangles it
// to `C:\c\Users\...`, which then matches no surface. Fold the MSYS drive form to a
// native Windows drive first. No-op off win32 and for paths that already carry a
// drive letter (e.g. `C:/Users/...`, which some MSYS builds export instead).
export function msysToWindowsCwd(pwd: string, platform: string): string {
  if (platform !== 'win32') return pwd;
  const match = pwd.match(/^\/([A-Za-z])\/(.*)$/);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}` : pwd;
}

// The host has no idea where `dor` was launched, so the caller's directory must
// travel in the request. Prefer the shell's PWD (injectable, matches what the
// user sees) and fall back to the process cwd. resolvePath canonicalizes both the
// default and a relative/absolute path into one absolute path the host can key on.
// Shared by `dor ensure --cwd` and `dor list --cwd`.
export function callerWorkingDirectory(flag: string | undefined, env: CliEnv | undefined): string {
  const base = msysToWindowsCwd(env?.PWD ?? process.cwd(), process.platform);
  return resolvePath(base, flag ?? '.');
}
