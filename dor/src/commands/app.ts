/**
 * `dor app` — verbs on the running app itself (`app.*` control methods). Only
 * `restart` exists: it asks Dormouse Standalone to quit and reopen, resuming the
 * Claude and Codex sessions its quit captures (`docs/specs/dor-cli.md` →
 * "dor app").
 *
 * A leading action, like `dor workspace`, so the command keeps one help page
 * and room for more verbs.
 */

import { buildCommand } from '@stricli/core';
import type { AppRestartResponse, Command, ControlClient, DorCommandContext, ParseResult } from './types.js';
import { errorMessage, renderJson, requireControlClient, stringParser, writeStdout } from './shared.js';

interface AppFlags {
  readonly json?: boolean;
}

interface AppActionSpec {
  /** The arguments and flags after the action name, as help prints them. */
  usage: string;
  run: (client: ControlClient) => Promise<AppRestartResponse>;
}

const ACTIONS = {
  restart: {
    usage: '[--json]',
    run: (client) => client.restartApp(),
  },
} as const satisfies Record<string, AppActionSpec>;

type AppAction = keyof typeof ACTIONS;

const ACTION_NAMES = Object.keys(ACTIONS) as AppAction[];
const USAGE = ACTION_NAMES.map((name) => `${name} ${ACTIONS[name].usage}`);

/** What a Dormouse from before `app.*` answers: its Wall's catch-all refusal. */
const PREDATES_APP_RESTART = `unsupported Dormouse control method 'app.restart'`;

export const appCommand: Command = {
  name: 'app',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor app [--json]<TO-EOL>',
        `  dor app ${ACTION_NAMES.join('|')} [--json]\n`,
      ],
    },
  ],
  command: buildCommand<AppFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Restart Dormouse Standalone, resuming Claude and Codex sessions.',
      customUsage: USAGE,
      fullDescription: `Acts on the running Dormouse app. Available only in Dormouse Standalone.

restart quits Dormouse and reopens it. Every window and Workspace comes back with its layout and working directories, and Claude and Codex sessions resume where they left off. Every other process is stopped and all scrollback is cleared. It goes through the app's normal quit, so Dormouse asks first when commands are still running (this command's own terminal does not count). A development build refuses, since its dev server does not survive a relaunch.

Text output:
  restarting Dormouse; Claude and Codex sessions resume when it reopens

JSON output:
  {
    "status": "restarting"
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
  const parsed = parseAction(args[0]);
  if (!parsed.ok) return new Error(parsed.message);
  if (args.length > 1) return new Error(`dor app ${parsed.value} takes no arguments`);

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  let response: AppRestartResponse;
  try {
    response = await ACTIONS[parsed.value].run(client);
  } catch (error) {
    const message = errorMessage(error);
    // VS Code answers the same way, and there the hint would be wrong.
    if (message === PREDATES_APP_RESTART && this.options.env?.DORMOUSE_HOST === 'standalone') {
      return new Error('this Dormouse predates dor app restart; quit it and reopen it instead');
    }
    return new Error(message);
  }
  if (!response.relaunch) {
    return new Error('a quit is already in progress; Dormouse will quit without relaunching');
  }
  writeStdout(this, flags.json === true
    ? renderJson({ status: 'restarting' })
    : 'restarting Dormouse; Claude and Codex sessions resume when it reopens\n');
  return undefined;
}

function parseAction(value: string | undefined): ParseResult<AppAction> {
  const action = ACTION_NAMES.find((candidate) => candidate === value);
  if (action) return { ok: true, value: action };
  return {
    ok: false,
    message: value === undefined
      ? `dor app requires an action: ${ACTION_NAMES.join(', ')}`
      : `unknown dor app action '${value}' (expected ${ACTION_NAMES.join(', ')})`,
  };
}
