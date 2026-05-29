import { SocketControlClient } from '../control-client.js';
import type {
  CliOptions,
  CliResult,
  ControlClient,
  IdFormat,
  ParseResult,
} from './types.js';

export function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '' };
}

export function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `Error: ${message}\n` };
}

export function takeFlagValue(args: string[], index: number, flag: string): ParseResult<string> {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    return { ok: false, message: `${flag} requires a value` };
  }
  return { ok: true, value };
}

export function isIdFormat(value: string): value is IdFormat {
  return value === 'refs' || value === 'uuids' || value === 'both';
}

export function validateSingletonTargets(workspace: string | undefined, window: string | undefined): ParseResult<void> {
  if (workspace && workspace !== 'workspace:1' && workspace !== '1') {
    return { ok: false, message: `unsupported workspace target '${workspace}'` };
  }
  if (window && window !== 'window:1' && window !== '1') {
    return { ok: false, message: `unsupported window target '${window}'` };
  }
  return { ok: true, value: undefined };
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
