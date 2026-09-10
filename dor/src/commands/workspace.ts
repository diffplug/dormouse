/**
 * `dor workspace` — the Workspace mutation verbs (`workspace.*` control
 * methods). Enumeration lives in `dor list` alone (`--workspaces` for the
 * overview, `--all` for every Workspace's Surfaces), so this command never
 * grows a `list`.
 *
 * One command with a leading action rather than a route map: `dor` has no other
 * nested command, and the generated help — one page per top-level command — is
 * what the published CLI reference renders (`docs/specs/website-docs.md`).
 */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  ControlClient,
  DorCommandContext,
  ParseResult,
  WorkspaceMutationResponse,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface WorkspaceFlags {
  readonly force?: boolean;
  readonly json?: boolean;
  readonly window?: string;
  readonly index?: number;
  readonly dangerouslyDestroyIframePageState?: boolean;
}

/** One action of `dor workspace`: how it is spelled in help, what argument
 *  count it takes and what to say when the count is wrong, and the verb it
 *  calls. Enumerated once so help, parsing, and dispatch cannot drift. */
interface WorkspaceActionSpec {
  /** The arguments and flags after the action name, as help prints them. */
  usage: string;
  accepts: (args: string[]) => boolean;
  arityError: string;
  run: (client: ControlClient, args: string[], flags: WorkspaceFlags) => Promise<WorkspaceMutationResponse>;
}

const ACTIONS = {
  new: {
    usage: '[name] [--json]',
    accepts: (args) => args.length <= 1,
    arityError: 'dor workspace new takes an optional name',
    run: (client, args) => client.newWorkspace(args[0] === undefined ? {} : { name: args[0] }),
  },
  rename: {
    usage: '<workspace> <name> [--json]',
    accepts: (args) => args.length === 2,
    arityError: 'dor workspace rename takes a workspace and a name',
    run: (client, args) => client.renameWorkspace({ workspace: args[0], name: args[1] }),
  },
  close: {
    usage: '<workspace> [--force] [--json]',
    accepts: (args) => args.length === 1,
    arityError: 'dor workspace close takes one workspace',
    run: (client, args, flags) => client.closeWorkspace({ workspace: args[0], force: flags.force === true }),
  },
  switch: {
    usage: '<workspace> [--json]',
    accepts: (args) => args.length === 1,
    arityError: 'dor workspace switch takes one workspace',
    run: (client, args) => client.switchWorkspace({ workspace: args[0] }),
  },
  move: {
    usage: '<workspace> [--window <label|new>] [--index <n>] [--dangerously-destroy-iframe-page-state] [--json]',
    accepts: (args) => args.length === 1,
    arityError: 'dor workspace move takes one workspace',
    run: (client, args, flags) => client.moveWorkspace({
      workspace: args[0],
      ...(flags.window === undefined ? {} : { toWindow: flags.window }),
      ...(flags.index === undefined ? {} : { index: flags.index }),
      dangerouslyDestroyIframePageState: flags.dangerouslyDestroyIframePageState === true,
    }),
  },
} as const satisfies Record<string, WorkspaceActionSpec>;

type WorkspaceAction = keyof typeof ACTIONS;

const ACTION_NAMES = Object.keys(ACTIONS) as WorkspaceAction[];
const USAGE = ACTION_NAMES.map((name) => `${name} ${ACTIONS[name].usage}`);

export const workspaceCommand: Command = {
  name: 'workspace',
  helpPatches: [
    {
      // stricli renders one usage line per command in root help; the four
      // actions collapse to the shape they share.
      scope: 'root',
      findReplace: [
        '  dor workspace [--force] [--json] [--window label] [--index n] [--dangerously-destroy-iframe-page-state]<TO-EOL>',
        `  dor workspace ${ACTION_NAMES.join('|')} [args...] [flags...]\n`,
      ],
    },
  ],
  command: buildCommand<WorkspaceFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Create, rename, close, switch, or move Workspaces.',
      customUsage: USAGE,
      fullDescription: `Manages this Window's Workspaces. Listing them is dor list --workspaces (the overview) and dor list --all (every Workspace's Surfaces); this command only mutates.

A <workspace> target is workspace:<n> — a stable number that a strip reorder or a move between windows never changes — or workspace:<name>, which resolves only when exactly one Workspace carries that name and otherwise fails listing the candidates. Both forms are also accepted bare ("2", "build"). A target in another window is routed there.

new creates a Workspace in the background and prints its ref: it never moves the user to it, since that is a larger theft than the focus a bare dor split takes. Use dor workspace switch to activate one. Without a name, the Workspace is named "Workspace N".

close archives and kills every Surface in the Workspace. It refuses — raising no confirmation, because the caller is a command rather than someone watching the Wall — when the Workspace holds a Surface the user has typed into or a running command; --force closes it anyway. The last remaining Workspace cannot be closed.

move puts a Workspace in another window (--window <label>, or --window new to tear it out into its own) and/or at a strip position (--index <n>, 0-based). Nothing is archived or killed: its terminals, notes, and pins travel whole. The one thing a move between windows cannot carry is a plain iframe's page state — the document cannot leave its webview, so the iframe reopens at its saved URL — and the move is refused when the Workspace holds one unless --dangerously-destroy-iframe-page-state is passed. Agent-browser Surfaces are not affected.

Text output:
  created workspace:2 "build"
  closed workspace:2 "build"
  moved workspace:2 "build"

JSON output:
  {
    "status": "created",
    "workspace_id": "...",
    "workspace_ref": "workspace:2",
    "name": "build"
  }`,
    },
    parameters: {
      flags: {
        force: { kind: 'boolean', brief: 'Close even when the Workspace holds running or touched Surfaces.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        window: { kind: 'parsed', parse: stringParser, brief: 'move: the window to move to (a label, or "new").', optional: true, placeholder: 'label' },
        index: { kind: 'parsed', parse: indexParser, brief: 'move: the 0-based strip position to move to.', optional: true, placeholder: 'n' },
        dangerouslyDestroyIframePageState: { kind: 'boolean', brief: 'move: accept losing every iframe Surface\'s page state.', optional: true, withNegated: false },
      },
      positional: {
        kind: 'array',
        minimum: 0,
        parameter: { parse: stringParser, brief: 'Action, then its arguments.', placeholder: 'args' },
      },
    },
    func: runWorkspaceCommand,
  }),
};

async function runWorkspaceCommand(
  this: DorCommandContext,
  flags: WorkspaceFlags,
  ...args: string[]
): Promise<void | Error> {
  const parsed = parseAction(args[0]);
  if (!parsed.ok) return new Error(parsed.message);
  const action = ACTIONS[parsed.value];
  const rest = args.slice(1);
  if (!action.accepts(rest)) return new Error(action.arityError);
  if (flags.force === true && parsed.value !== 'close') {
    return new Error('--force applies only to dor workspace close');
  }
  if (parsed.value !== 'move') {
    if (flags.window !== undefined) return new Error('--window applies only to dor workspace move');
    if (flags.index !== undefined) return new Error('--index applies only to dor workspace move');
    if (flags.dangerouslyDestroyIframePageState === true) {
      return new Error('--dangerously-destroy-iframe-page-state applies only to dor workspace move');
    }
  } else if (flags.window === undefined && flags.index === undefined) {
    return new Error('dor workspace move needs --window, --index, or both');
  }

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await action.run(client, rest, flags);
    writeStdout(this, renderWorkspaceResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function indexParser(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) throw new Error(`--index must be a non-negative integer, got '${value}'`);
  return index;
}

function parseAction(value: string | undefined): ParseResult<WorkspaceAction> {
  const action = ACTION_NAMES.find((candidate) => candidate === value);
  if (action) return { ok: true, value: action };
  // The one wrong guess worth answering by name: enumeration lives in dor list.
  if (value === 'list') {
    return { ok: false, message: 'dor list --workspaces prints the Workspace overview; dor workspace only mutates' };
  }
  return {
    ok: false,
    message: value === undefined
      ? `dor workspace requires an action: ${ACTION_NAMES.join(', ')}`
      : `unknown dor workspace action '${value}' (expected ${ACTION_NAMES.join(', ')})`,
  };
}

function renderWorkspaceResponse(response: WorkspaceMutationResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      workspace_id: response.workspaceId,
      workspace_ref: response.workspaceRef,
      name: response.name,
    });
  }
  return `${response.status} ${response.workspaceRef} ${JSON.stringify(response.name)}\n`;
}
