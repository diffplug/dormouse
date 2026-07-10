/** Private `surface.split` command wiring and response rendering. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  SplitDirection,
  SplitSurfaceResponse,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface SplitFlags {
  readonly auto?: boolean;
  readonly down?: boolean;
  readonly json?: boolean;
  readonly left?: boolean;
  readonly minimize?: boolean;
  readonly right?: boolean;
  readonly surface?: string;
  readonly up?: boolean;
}

const groupedSplitDirectionUsage = '[--left|--right|--up|--down|--auto]';

export const splitCommand: Command = {
  name: 'split',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor split [--auto]',
        `  dor split ${groupedSplitDirectionUsage}`,
      ],
      remove: ['<WS>[--down]', '<WS>[--left]', '<WS>[--right]', '<WS>[--up]'],
    },
    {
      scope: 'root',
      findReplace: [
        `  dor split ${groupedSplitDirectionUsage} [--json] [--minimize] [--surface id|ref]<TO-EOL>`,
        `  dor split ${groupedSplitDirectionUsage} [--json] [--minimize] [--surface id|ref] [-- <command>...]\n`,
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '[--auto]',
        `${groupedSplitDirectionUsage}`,
        '[--surface id|ref]<TO-EOL>',
        '[--surface id|ref] [-- <command>...]\n',
      ],
      remove: ['<WS>[--down]', '<WS>[--left]', '<WS>[--right]', '<WS>[--up]'],
    },
    {
      scope: 'command-detail',
      findReplace: [
        '<LS>[--auto]<TO-EOL>',
        '     [--left|--right|--up|--down|--auto]\n                  Split direction. Mutually exclusive; default is --auto.\n',
      ],
      remove: [
        '<LS>[--down]<TO-EOL>',
        '<LS>[--left]<TO-EOL>',
        '<LS>[--right]<TO-EOL>',
        '<LS>[--up]<TO-EOL>',
        '\nARGUMENTS<TO-EOL><LS>command<TO-EOL>',
      ],
    },
  ],
  command: buildCommand<SplitFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Create a new terminal surface by splitting an existing surface.',
      fullDescription: `If no direction is provided, --auto is used. --auto chooses right when the target surface is wide, down when it is narrow, and right when the target is minimized.

Use -- followed by a command to run an initial command in the new terminal surface.

Focus depends only on whether you pass --. A bare "dor split" (no --) moves focus to the new surface so a human can start typing in it — avoid it in automation, since it steals the user's keystrokes. Anything with -- leaves focus on the caller: "dor split -- <command>" runs the command in the background, and a bare "dor split --" opens a blank terminal without stealing focus.

--minimize creates the surface and immediately sends it to the minimized area.

--surface selects the surface to split. If the target is minimized, the new surface is created minimized too and inserted immediately to the right of the target door. If omitted, Dormouse uses the caller surface when available, then the focused surface.

split creates terminal Surfaces. Compose browser content commands through the initial command:

  dor split --right -- dor iframe https://example.com
  dor split --auto -- dor agent-browser open https://example.com

Text output:
  created surface:2  [right]
  created surface:3  [down]  [minimized]  "pnpm dev"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-abc",
    "surface_ref": "surface:2",
    "direction": "right",
    "minimized": false,
    "command": "pnpm dev"
  }`,
    },
    parameters: {
      flags: {
        auto: { kind: 'boolean', brief: 'Default; choose right when wide and down when narrow.', optional: true, withNegated: false },
        down: { kind: 'boolean', brief: 'Split below the target surface.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        left: { kind: 'boolean', brief: 'Split left of the target surface.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        right: { kind: 'boolean', brief: 'Split right of the target surface.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split.', optional: true, placeholder: 'id|ref' },
        up: { kind: 'boolean', brief: 'Split above the target surface.', optional: true, withNegated: false },
      },
      positional: {
        kind: 'array',
        minimum: 0,
        parameter: { parse: stringParser, brief: 'Initial command to run.', placeholder: 'command' },
      },
    },
    func: runSplitCommand,
  }),
};

async function runSplitCommand(this: DorCommandContext, flags: SplitFlags, ...commandArgs: string[]): Promise<void | Error> {
  const direction = parseSplitDirection(flags);
  if (!direction.ok) return new Error(direction.message);
  const command = commandArgs.length > 0 ? commandArgs : undefined;

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.splitSurface({
      ...(command ? { command } : {}),
      direction: direction.value,
      minimized: flags.minimize === true,
      surface: flags.surface,
      // A `--` tail — with or without a command — leaves focus on the caller.
      // Only a truly bare `dor split` (no `--`) moves focus to the new surface.
      focusNeutral: this.hasArgumentEscape,
    });
    writeStdout(this, renderSplitResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function parseSplitDirection(flags: SplitFlags): ParseResult<SplitDirection> {
  const explicitDirections: SplitDirection[] = [];
  if (flags.left) explicitDirections.push('left');
  if (flags.right) explicitDirections.push('right');
  if (flags.up) explicitDirections.push('up');
  if (flags.down) explicitDirections.push('down');
  if (flags.auto) explicitDirections.push('auto');

  if (explicitDirections.length > 1) {
    return { ok: false, message: 'direction flags are mutually exclusive' };
  }

  return { ok: true, value: explicitDirections[0] ?? 'auto' };
}

function renderSplitResponse(response: SplitSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      direction: response.direction,
      minimized: response.minimized,
      ...(response.command ? { command: response.command } : {}),
    });
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  const command = response.command ? `  ${JSON.stringify(response.command)}` : '';
  return `${response.status} ${response.surfaceRef}  [${response.direction}]${minimized}${command}\n`;
}
