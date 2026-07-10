/** Private `surface.read` command wiring and response rendering. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ReadSurfaceResponse,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface ReadFlags {
  readonly json?: boolean;
  readonly lines?: number;
  readonly scrollback?: boolean;
}

export const readCommand: Command = {
  name: 'read',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor read [--json] [--lines count] [--scrollback]<TO-EOL>',
        '  dor read <surface> [--json] [--lines count] [--scrollback]\n',
      ],
    },
  ],
  command: buildCommand<ReadFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Read terminal text from a surface.',
      customUsage: ['<surface> [--json] [--lines count] [--scrollback]'],
      fullDescription: `Reads the visible screen text from the target terminal surface. Use --scrollback to include terminal history, and --lines to limit how much text is returned.

Text mode prints terminal text directly.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "text": "..."
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        lines: { kind: 'parsed', parse: parseLineCount, brief: 'Maximum number of lines to return.', optional: true, placeholder: 'count' },
        scrollback: { kind: 'boolean', brief: 'Include terminal scrollback/history instead of only the visible screen.', optional: true, withNegated: false },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: stringParser, brief: 'Surface to read.', placeholder: 'surface' },
        ],
      },
    },
    func: runReadCommand,
  }),
};

async function runReadCommand(this: DorCommandContext, flags: ReadFlags, surface: string): Promise<void | Error> {
  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.readSurface({
      ...(flags.lines !== undefined ? { lines: flags.lines } : {}),
      scrollback: flags.scrollback === true,
      surface,
    });
    writeStdout(this, renderReadResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function parseLineCount(input: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyntaxError(`invalid --lines '${input}'`);
  }
  return value;
}

function renderReadResponse(response: ReadSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      workspace_ref: response.workspaceRef,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      text: response.text,
    });
  }

  // Terminal text comes back with trailing newlines stripped; re-add one so the
  // next shell prompt starts on its own line, matching the JSON branch.
  return `${response.text}\n`;
}
