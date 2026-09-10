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
}

const ACTIONS = ['new', 'rename', 'close', 'switch'] as const;
type WorkspaceAction = (typeof ACTIONS)[number];

const USAGE = [
  'new [name] [--json]',
  'rename <workspace> <name> [--json]',
  'close <workspace> [--force] [--json]',
  'switch <workspace> [--json]',
];

export const workspaceCommand: Command = {
  name: 'workspace',
  helpPatches: [
    {
      // stricli renders one usage line per command in root help; the four
      // actions collapse to the shape they share.
      scope: 'root',
      findReplace: [
        '  dor workspace [--force] [--json]<TO-EOL>',
        '  dor workspace new|rename|close|switch [args...] [--force] [--json]\n',
      ],
    },
  ],
  command: buildCommand<WorkspaceFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Create, rename, close, or switch Workspaces.',
      customUsage: USAGE,
      fullDescription: `Manages this Window's Workspaces. Listing them is dor list --workspaces (the overview) and dor list --all (every Workspace's Surfaces); this command only mutates.

A <workspace> target is workspace:<n> — positional, so a strip reorder renumbers it — or workspace:<name>, which resolves only when exactly one Workspace carries that name and otherwise fails listing the candidates. Both forms are also accepted bare ("2", "build").

new creates a Workspace in the background and prints its ref: it never moves the user to it, since that is a larger theft than the focus a bare dor split takes. Use dor workspace switch to activate one. Without a name, the Workspace is named "Workspace N".

close archives and kills every Surface in the Workspace. It refuses — raising no confirmation, because the caller is a command rather than someone watching the Wall — when the Workspace holds a Surface the user has typed into or a running command; --force closes it anyway. The last remaining Workspace cannot be closed.

Text output:
  created workspace:2 "build"
  closed workspace:2 "build"

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
  const action = parseAction(args[0]);
  if (!action.ok) return new Error(action.message);
  const rest = args.slice(1);
  const arity = checkArity(action.value, rest);
  if (!arity.ok) return new Error(arity.message);
  if (flags.force === true && action.value !== 'close') {
    return new Error('--force applies only to dor workspace close');
  }

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await runAction(client, action.value, rest, flags);
    writeStdout(this, renderWorkspaceResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function parseAction(value: string | undefined): ParseResult<WorkspaceAction> {
  const action = ACTIONS.find((candidate) => candidate === value);
  if (action) return { ok: true, value: action };
  // The one wrong guess worth answering by name: enumeration lives in dor list.
  if (value === 'list') {
    return { ok: false, message: 'dor list --workspaces prints the Workspace overview; dor workspace only mutates' };
  }
  return {
    ok: false,
    message: value === undefined
      ? `dor workspace requires an action: ${ACTIONS.join(', ')}`
      : `unknown dor workspace action '${value}' (expected ${ACTIONS.join(', ')})`,
  };
}

function checkArity(action: WorkspaceAction, rest: string[]): ParseResult<void> {
  const expected: Record<WorkspaceAction, string> = {
    new: 'dor workspace new takes an optional name',
    rename: 'dor workspace rename takes a workspace and a name',
    close: 'dor workspace close takes one workspace',
    switch: 'dor workspace switch takes one workspace',
  };
  const ok = action === 'new'
    ? rest.length <= 1
    : action === 'rename'
      ? rest.length === 2
      : rest.length === 1;
  return ok ? { ok: true, value: undefined } : { ok: false, message: expected[action] };
}

function runAction(
  client: ControlClient,
  action: WorkspaceAction,
  rest: string[],
  flags: WorkspaceFlags,
): Promise<WorkspaceMutationResponse> {
  switch (action) {
    case 'new':
      return client.newWorkspace(rest[0] === undefined ? {} : { name: rest[0] });
    case 'rename':
      return client.renameWorkspace({ workspace: rest[0], name: rest[1] });
    case 'close':
      return client.closeWorkspace({ workspace: rest[0], force: flags.force === true });
    case 'switch':
      return client.switchWorkspace({ workspace: rest[0] });
  }
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
