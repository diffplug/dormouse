/** Private `surface.ensure` wiring for title-based idempotency. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  EnsureSurfaceResponse,
} from './types.js';
import {
  resolveControlClient,
  stringParser,
  writeStdout,
} from './shared.js';
import { buildShellCommand } from './shell-command.js';

interface EnsureFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly surface?: string;
  readonly title?: string;
}

export const ensureCommand: Command = {
  name: 'ensure',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor ensure [--json] [--minimize] [--surface id|ref|index] [--title value]<TO-EOL>',
        '  dor ensure [--json] [--minimize] [--surface id|ref|index] [--title value] -- <command>...\n',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor ensure [--json] [--minimize] [--surface id|ref|index] [--title value]<TO-EOL>',
        '  dor ensure [--json] [--minimize] [--surface id|ref|index] [--title value] -- <command>...\n',
      ],
    },
    {
      scope: 'command-detail',
      remove: ['\nARGUMENTS<TO-EOL><LS>command...<TO-EOL>'],
    },
  ],
  command: buildCommand<EnsureFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Ensure one surface exists for a user-enforced title.',
      fullDescription: `Ensures one surface exists in the current workspace for a user-enforced title. The idempotency key is always the user-enforced title.

If --title is omitted, Dormouse derives the title from the command after --.

If a surface in the current workspace already has the enforced title, Dormouse returns that surface and does not start another command.

If no surface has that enforced title, Dormouse creates a split, starts the command, marks the surface title as user-enforced, and returns the new surface.

A user-enforced title is visible in the UI and must not be overwritten by terminal title escape sequences from the running process.

Matching uses Dormouse metadata, not process inspection. Minimized surfaces participate in matching. Closed/killed surfaces do not participate in matching.

--minimize applies only when creating a new surface; it does not minimize an existing match.

--surface selects the surface to split only when creating a new surface. If omitted, Dormouse uses the same caller/focused fallback as dor split.

No workspace argument exists until Dormouse supports multiple workspaces.

Text output:
  created surface:3  "dev server"
  existing surface:3  "dev server"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "title": "dev server",
    "command": "pnpm dev:workspace",
    "minimized": false
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref|index' },
        title: { kind: 'parsed', parse: stringParser, brief: 'User-enforced surface title.', optional: true },
      },
      positional: {
        kind: 'array',
        minimum: 1,
        parameter: { parse: stringParser, brief: 'Command to run.', placeholder: 'command' },
      },
    },
    func: runEnsureCommand,
  }),
};

async function runEnsureCommand(this: DorCommandContext, flags: EnsureFlags, ...commandArgs: string[]): Promise<void | Error> {
  const command = buildShellCommand(commandArgs, this.options.env);
  if (!command) {
    return new Error('dor ensure requires a command after --');
  }

  let title = flags.title;
  if (title !== undefined) {
    title = title.trim();
    if (title === '') {
      return new Error('dor ensure --title must not be empty');
    }
  }

  const clientResult = resolveControlClient(this.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const response = await clientResult.value.ensureSurface({
      command,
      minimized: flags.minimize === true,
      surface: flags.surface,
      title,
    });
    writeStdout(this, renderEnsureResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

function renderEnsureResponse(response: EnsureSurfaceResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      title: response.title,
      command: response.command,
      minimized: response.minimized,
    }, null, 2)}\n`;
  }

  return `${response.status} ${response.surfaceRef}  ${JSON.stringify(response.title)}\n`;
}
