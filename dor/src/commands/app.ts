/**
 * `dor app` — verbs on the running app itself; only `restart` exists
 * (`docs/specs/dor-cli.md` → "dor app"). A leading action, like `dor workspace`.
 */

import { buildCommand } from '@stricli/core';
import { APP_CONTROL_METHODS, unsupportedControlMethodMessage } from '../protocol.js';
import type { AppRestartResponse, Command, DorCommandContext } from './types.js';
import { errorMessage, renderJson, requireControlClient, stringParser, writeStdout } from './shared.js';

interface AppFlags {
  readonly json?: boolean;
}

export const appCommand: Command = {
  name: 'app',
  helpPatches: [
    {
      scope: 'root',
      findReplace: ['  dor app [--json]<TO-EOL>', '  dor app restart [--json]\n'],
    },
  ],
  command: buildCommand<AppFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Restart Dormouse Standalone, resuming Claude and Codex sessions.',
      customUsage: ['restart [--json]'],
      fullDescription: `Acts on the running Dormouse app. Available only in Dormouse Standalone.

restart quits Dormouse and reopens it. Every window and Workspace comes back with its layout and working directories, and Claude and Codex sessions resume where they left off. Every other process is stopped and all scrollback is cleared. It goes through the app's normal quit, so Dormouse asks first when commands are still running (this command's own terminal does not count). A development build refuses, since its dev server does not survive a relaunch.

Text output:
  restart requested; Dormouse asks first if commands are running, and Claude and Codex sessions resume when it reopens

JSON output:
  {
    "status": "requested"
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
      },
      positional: {
        kind: 'array',
        minimum: 0,
        parameter: { parse: stringParser, brief: 'Action.', placeholder: 'args' },
      },
    },
    func: runAppCommand,
  }),
};

async function runAppCommand(
  this: DorCommandContext,
  flags: AppFlags,
  ...args: string[]
): Promise<void | Error> {
  if (args[0] !== 'restart') {
    return new Error(args[0] === undefined
      ? 'dor app requires an action: restart'
      : `unknown dor app action '${args[0]}' (expected restart)`);
  }
  if (args.length > 1) return new Error('dor app restart takes no arguments');

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  let response: AppRestartResponse;
  try {
    response = await client.restartApp();
  } catch (error) {
    const message = errorMessage(error);
    // VS Code refuses with the same text, and there the hint would be wrong.
    if (message === unsupportedControlMethodMessage(APP_CONTROL_METHODS.restart)
      && this.options.env?.DORMOUSE_HOST === 'standalone') {
      return new Error('this Dormouse predates dor app restart; quit it and reopen it instead');
    }
    return new Error(message);
  }
  if (!response.relaunch) {
    return new Error('a quit is already in progress; Dormouse will quit without relaunching');
  }
  writeStdout(this, flags.json === true
    ? renderJson({ status: 'requested' })
    : 'restart requested; Dormouse asks first if commands are running, and Claude and Codex sessions resume when it reopens\n');
  return undefined;
}
