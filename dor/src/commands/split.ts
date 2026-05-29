/**
 * # `dor split`
 *
 * Usage:
 *
 * ```text
 * dor split [--left|--right|--up|--down|--auto] [--command <cmd>] [--minimize] [--surface <id|ref|index>] [--json]
 * ```
 *
 * Behavior:
 *
 * - Calls the private `surface.split` control method.
 * - Creates a new terminal surface by splitting an existing surface.
 * - Direction flags are mutually exclusive. If no direction is provided,
 *   `--auto` is used.
 * - `--auto` chooses `right` when the target surface is wide and `down` when it
 *   is narrow.
 * - `--surface` selects the surface to split. If omitted, Dormouse uses the
 *   caller surface when available, then the focused surface.
 * - `--command` runs the given command as the new terminal surface's initial
 *   command.
 * - `--minimize` creates the surface and immediately sends it to the minimized
 *   area.
 * - No workspace argument exists until Dormouse supports multiple workspaces.
 * - `split` does not know about non-terminal surface types. Compose future
 *   content commands through the terminal:
 *
 * ```sh
 * dor split --right --command "dor iframe https://example.com"
 * dor split --auto --command "dor agent-browser open https://example.com"
 * ```
 *
 * Text shape:
 *
 * ```text
 * created surface:2  [right]
 * created surface:3  [down]  [minimized]  "pnpm dev"
 * ```
 *
 * JSON shape:
 *
 * ```json
 * {
 *   "status": "created",
 *   "surface_id": "pane-abc",
 *   "surface_ref": "surface:2",
 *   "direction": "right",
 *   "minimized": false,
 *   "command": "pnpm dev"
 * }
 * ```
 */

import type {
  CliOptions,
  CliResult,
  Command,
  ParseResult,
  SplitDirection,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
} from './types.js';
import {
  fail,
  ok,
  resolveControlClient,
  takeFlagValue,
} from './shared.js';

interface SplitOptions extends SplitSurfaceRequest {
  json: boolean;
}

const DIRECTION_FLAGS: Record<string, SplitDirection> = {
  '--left': 'left',
  '--right': 'right',
  '--up': 'up',
  '--down': 'down',
  '--auto': 'auto',
};

export const splitCommand: Command = {
  name: 'split',
  usage: 'Usage: dor split [--left|--right|--up|--down|--auto] [--command <cmd>] [--minimize] [--surface <id|ref|index>] [--json]\n',
  run: runSplitCommand,
};

async function runSplitCommand(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = parseSplitArgs(args);
  if (!parsed.ok) return fail(parsed.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
    const response = await clientResult.value.splitSurface(parsed.value);
    return ok(renderSplitResponse(response, parsed.value.json));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function parseSplitArgs(args: string[]): ParseResult<SplitOptions> {
  const result: SplitOptions = {
    json: false,
    direction: 'auto',
    minimized: false,
  };
  let explicitDirection: SplitDirection | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--minimize') {
      result.minimized = true;
    } else if (arg === '--command') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.command = value.value;
      index += 1;
    } else if (arg === '--surface') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.surface = value.value;
      index += 1;
    } else if (DIRECTION_FLAGS[arg]) {
      const direction = DIRECTION_FLAGS[arg];
      if (explicitDirection && explicitDirection !== direction) {
        return { ok: false, message: 'direction flags are mutually exclusive' };
      }
      explicitDirection = direction;
      result.direction = direction;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    } else {
      return { ok: false, message: `unexpected argument '${arg}'` };
    }
  }

  return { ok: true, value: result };
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
