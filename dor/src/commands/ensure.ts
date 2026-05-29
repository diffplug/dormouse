/**
 * # `dor ensure`
 *
 * Usage:
 *
 * ```text
 * dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>
 * ```
 *
 * Behavior:
 *
 * - Calls the private `surface.ensure` control method.
 * - Ensures one surface exists in the current workspace for a user-enforced
 *   title.
 * - The idempotency key is always the user-enforced title.
 * - If `--title` is omitted, Dormouse derives the title from the command after
 *   `--`.
 * - If a surface in the current workspace already has the enforced title,
 *   Dormouse returns that surface and does not start another command.
 * - If no surface has that enforced title, Dormouse creates a split, starts the
 *   command, marks the surface title as user-enforced, and returns the new
 *   surface.
 * - A user-enforced title is visible in the UI and must not be overwritten by
 *   terminal title escape sequences from the running process.
 * - Matching uses Dormouse metadata, not process inspection.
 * - Minimized surfaces participate in matching.
 * - `--minimize` applies only when creating a new surface; it does not minimize
 *   an existing match.
 * - `--surface` selects the surface to split only when creating a new surface.
 *   If omitted, Dormouse uses the same caller/focused fallback as `dor split`.
 * - Closed/killed surfaces do not participate in matching.
 * - No workspace argument exists until Dormouse supports multiple workspaces.
 *
 * Text shape:
 *
 * ```text
 * created surface:3  "dev server"
 * existing surface:3  "dev server"
 * ```
 *
 * JSON shape:
 *
 * ```json
 * {
 *   "status": "created",
 *   "surface_id": "pane-def",
 *   "surface_ref": "surface:3",
 *   "title": "dev server",
 *   "command": "pnpm dev:workspace",
 *   "minimized": false
 * }
 * ```
 */

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

interface EnsureFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly surface?: string;
  readonly title?: string;
}

export const ensureCommand: Command = {
  name: 'ensure',
  usage: 'Usage: dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>\n',
  command: buildCommand<EnsureFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Ensure one surface exists for a user-enforced title.',
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true },
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
  const command = commandArgs.join(' ').trim();
  if (!command) {
    return new Error('dor ensure requires a command after --');
  }

  const clientResult = resolveControlClient(this.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const response = await clientResult.value.ensureSurface({
      command,
      minimized: flags.minimize === true,
      surface: flags.surface,
      title: flags.title,
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
