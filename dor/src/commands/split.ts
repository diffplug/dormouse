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
  resolveControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface SplitFlags {
  readonly auto?: boolean;
  readonly command?: string;
  readonly down?: boolean;
  readonly json?: boolean;
  readonly left?: boolean;
  readonly minimize?: boolean;
  readonly right?: boolean;
  readonly surface?: string;
  readonly up?: boolean;
}

const groupedSplitDirectionUsage = '[--left|--right|--up|--down|--auto]';
const groupedSplitUsage = `${groupedSplitDirectionUsage} [--command cmd] [--json] [--minimize] [--surface id|ref|index]`;
const splitUsageBrief = 'Direction flags are mutually exclusive; --auto is the default.';

export const splitCommand: Command = {
  name: 'split',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor split [--auto]',
        `  dor split ${groupedSplitDirectionUsage}`,
      ],
      remove: [
        '<WS>[--down]',
        '<WS>[--left]',
        '<WS>[--right]',
        '<WS>[--up]',
      ],
    },
    {
      scope: 'command',
      findReplace: [
        '  dor split [--auto]',
        `  dor split ${groupedSplitDirectionUsage}`,
        '[--command cmd] [--down]',
        '[--command cmd]',
        '[--json] [--left]',
        '[--json]',
        '[--minimize] [--right]',
        '[--minimize]',
        '[--surface id|ref|index] [--up]',
        '[--surface id|ref|index]',
        `  dor split ${groupedSplitUsage}`,
        `  dor split ${groupedSplitUsage}\n    ${splitUsageBrief}`,
        '<LS>[--auto]<WS>Default; choose right when wide and down when narrow.<TO-EOL>',
        '     [--left|--right|--up|--down|--auto]\n                  Split direction. Mutually exclusive; default is --auto.\n',
      ],
      remove: [
        '<LS>[--down]<TO-EOL>',
        '<LS>[--left]<TO-EOL>',
        '<LS>[--right]<TO-EOL>',
        '<LS>[--up]<TO-EOL>',
      ],
    },
  ],
  command: buildCommand<SplitFlags, [], DorCommandContext>({
    docs: {
      brief: 'Create a new terminal surface by splitting an existing surface.',
      fullDescription: `If no direction is provided, --auto is used. --auto chooses right when the target surface is wide and down when it is narrow.

--surface selects the surface to split. If omitted, Dormouse uses the caller surface when available, then the focused surface.

--command runs the given command as the new terminal surface's initial command.

--minimize creates the surface and immediately sends it to the minimized area.

No workspace argument exists until Dormouse supports multiple workspaces.

split does not know about non-terminal surface types. Compose future content commands through the terminal:

  dor split --right --command "dor iframe https://example.com"
  dor split --auto --command "dor agent-browser open https://example.com"

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
        command: { kind: 'parsed', parse: stringParser, brief: 'Run an initial command in the new surface.', optional: true, placeholder: 'cmd' },
        down: { kind: 'boolean', brief: 'Split below the target surface.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        left: { kind: 'boolean', brief: 'Split left of the target surface.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        right: { kind: 'boolean', brief: 'Split right of the target surface.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split.', optional: true, placeholder: 'id|ref|index' },
        up: { kind: 'boolean', brief: 'Split above the target surface.', optional: true, withNegated: false },
      },
    },
    func: runSplitCommand,
  }),
};

async function runSplitCommand(this: DorCommandContext, flags: SplitFlags): Promise<void | Error> {
  const direction = parseSplitDirection(flags);
  if (!direction.ok) return new Error(direction.message);

  const clientResult = resolveControlClient(this.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const response = await clientResult.value.splitSurface({
      command: flags.command,
      direction: direction.value,
      minimized: flags.minimize === true,
      surface: flags.surface,
    });
    writeStdout(this, renderSplitResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
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
    return `${JSON.stringify({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      direction: response.direction,
      minimized: response.minimized,
      ...(response.command ? { command: response.command } : {}),
    }, null, 2)}\n`;
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  const command = response.command ? `  ${JSON.stringify(response.command)}` : '';
  return `${response.status} ${response.surfaceRef}  [${response.direction}]${minimized}${command}\n`;
}
