/**
 * `dor reopen` — the Reopen verb's `dor` counterpart
 * (`docs/specs/dor-cli.md` → "dor reopen").
 */

import { buildCommand } from '@stricli/core';
import { unsupportedControlMethodMessage, WINDOW_CONTROL_METHODS } from '../protocol.js';
import type { Command, DorCommandContext, ReopenResponse } from './types.js';
import { errorMessage, renderJson, requireControlClient, writeStdout } from './shared.js';

interface ReopenFlags {
  readonly json?: boolean;
}

export const reopenCommand: Command = {
  name: 'reopen',
  command: buildCommand<ReopenFlags, [], DorCommandContext>({
    docs: {
      brief: 'Reopen the most recently closed surface, workspace, or window.',
      customUsage: ['[--json]'],
      fullDescription: `Reopens the newest close this window remembers, as the Reopen Closed menu item and command-mode u do. Only a close Reopen can restore is remembered: a clean built-in file or folder viewer, an iframe browser, or a Workspace or window holding nothing else but untouched shells. A shell someone typed into, a running command, or unsaved work is never remembered, so closing one asks first. A reopened surface is a new surface with a new id, at the path or URL it had. Nothing is remembered across a restart.

Text output:
  reopened surface:4

JSON output:
  {
    "status": "reopened",
    "kind": "surface",
    "surface_id": "...",
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
      },
      positional: { kind: 'tuple', parameters: [] },
    },
    func: runReopenCommand,
  }),
};

async function runReopenCommand(this: DorCommandContext, flags: ReopenFlags): Promise<void | Error> {
  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;
  let response: ReopenResponse;
  try {
    response = await client.reopenClosed();
  } catch (error) {
    const message = errorMessage(error);
    if (message === unsupportedControlMethodMessage(WINDOW_CONTROL_METHODS.reopen)) {
      return new Error('this Dormouse predates dor reopen');
    }
    return new Error(message);
  }
  writeStdout(this, flags.json === true ? renderReopenJson(response) : `reopened ${reopenedId(response)}\n`);
  return undefined;
}

function reopenedId(response: ReopenResponse): string {
  if (response.kind === 'surface') return response.surfaceId;
  if (response.kind === 'workspace') return response.workspaceId;
  return 'window';
}

function renderReopenJson(response: ReopenResponse): string {
  const { status, kind } = response;
  if (kind === 'surface') return renderJson({ status, kind, surface_id: response.surfaceId });
  if (kind === 'workspace') return renderJson({ status, kind, workspace_id: response.workspaceId });
  return renderJson({ status, kind });
}
