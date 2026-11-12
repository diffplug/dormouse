/** Private `surface.split` command wiring and response rendering. */

import { buildCommand } from '@stricli/core';
import { commandError } from './errors.js';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  SplitDirection,
  SplitSurfaceResponse,
  WorkspaceScopedFlags,
} from './types.js';
import {
  callerWorkingDirectory,
  focusFlag,
  focusHelp,
  focusMinimizeConflict,
  renderJson,
  requireControlClient,
  scanPreDelimiterArgs,
  stringParser,
  workspaceFlag,
  workspaceParam,
  writeStdout,
} from './shared.js';

interface SplitFlags extends WorkspaceScopedFlags {
  readonly auto?: boolean;
  readonly down?: boolean;
  readonly focus?: boolean;
  readonly json?: boolean;
  readonly left?: boolean;
  readonly minimize?: boolean;
  readonly right?: boolean;
  readonly from?: string;
  readonly up?: boolean;
}

const groupedSplitDirectionUsage = '[--left|--right|--up|--down|--auto]';

export const splitCommand: Command = {
  name: 'split',
  preParse(args) {
    const delimiter = args.indexOf('--');
    const scan = scanPreDelimiterArgs(delimiter < 0 ? args : args.slice(0, delimiter), {
      booleans: new Set(['--focus', '--auto', '--down', '--up', '--left', '--right', '--json', '--minimize']),
      valued: new Set(['--from', '--workspace']),
      positionals: 'reject',
    });
    return scan.ok ? { ok: true, value: undefined } : scan;
  },
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
        `  dor split ${groupedSplitDirectionUsage} [--focus] [--json] [--minimize] [--from handle] [--workspace ref]<TO-EOL>`,
        `  dor split ${groupedSplitDirectionUsage} [--focus] [--json] [--minimize] [--from handle] [--workspace ref] [-- <command>...]\n`,
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '[--auto]',
        `${groupedSplitDirectionUsage}`,
        // <TO-EOL> swallows the flags this patch is about to remove, so the
        // tail is rewritten whole rather than matched around them.
        '[--from handle]<TO-EOL>',
        '[--from handle] [--workspace ref] [-- <command>...]\n',
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

The new terminal starts in the directory where you invoke dor split. --from and --workspace control placement; they do not change the working directory.

Use -- followed by a command to run an initial command in the new terminal surface. Only split's own options come before --.

${focusHelp({ minimize: true })}

--minimize creates the surface and immediately sends it to the minimized area.

--from selects the reference Surface for placement. If it is minimized, the new Surface is created minimized too and inserted immediately to the right of its Door, unless --focus lays it out from the Door's place instead. If --from is omitted, Dormouse uses the caller's Surface, or an auxiliary helper's source Surface. When --workspace selects another Workspace, placement defaults to that Workspace's focused Surface.

From an auxiliary helper, split creates a separate terminal and leaves the helper in place. Helpers cannot be explicit Surface targets, including surface:self.

split creates terminal Surfaces. Compose browser content commands through the initial command:

  dor split --right -- dor iframe :5173
  dor split --auto -- dor agent-browser open https://example.com

split answers once the Surface exists, without waiting for an initial command to start, so its JSON command_state is always unconfirmed; check readiness separately.

Text output:
  created surface:2  [right]
  created surface:3  [down]  [minimized]  "pnpm dev"

JSON output:
  {
    "status": "created",
    "command_state": "unconfirmed",
    "surface_id": "surface:2",
    "direction": "right",
    "minimized": false,
    "command": "pnpm dev"
  }`,
    },
    parameters: {
      flags: {
        auto: { kind: 'boolean', brief: 'Default; choose right when wide and down when narrow.', optional: true, withNegated: false },
        down: { kind: 'boolean', brief: 'Split below the target surface.', optional: true, withNegated: false },
        focus: focusFlag,
        json: { kind: 'boolean', brief: 'Print a JSON result or error object.', optional: true, withNegated: false },
        left: { kind: 'boolean', brief: 'Split left of the target surface.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        right: { kind: 'boolean', brief: 'Split right of the target surface.', optional: true, withNegated: false },
        from: { kind: 'parsed', parse: stringParser, brief: 'Reference Surface for placement.', optional: true, placeholder: 'handle' },
        up: { kind: 'boolean', brief: 'Split above the target surface.', optional: true, withNegated: false },
        workspace: workspaceFlag,
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
  const conflict = focusMinimizeConflict(flags);
  if (conflict) return conflict;
  const direction = parseSplitDirection(flags);
  if (!direction.ok) return new Error(direction.message);
  const command = commandArgs.length > 0 ? commandArgs : undefined;

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.splitSurface({
      ...(command ? { command } : {}),
      direction: direction.value,
      cwd: callerWorkingDirectory(undefined, this.options),
      minimized: flags.minimize === true,
      focus: flags.focus === true,
      surface: flags.from,
      ...workspaceParam(flags.workspace),
    });
    writeStdout(this, renderSplitResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return commandError(error);
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
      command_state: response.commandState,
      surface_id: response.surfaceId,
      direction: response.direction,
      minimized: response.minimized,
      ...(response.command ? { command: response.command } : {}),
    });
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  const command = response.command ? `  ${JSON.stringify(response.command)}` : '';
  return `${response.status} ${response.surfaceId}  [${response.direction}]${minimized}${command}\n`;
}
