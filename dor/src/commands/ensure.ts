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

import type {
  CliOptions,
  CliResult,
  Command,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  ParseResult,
} from './types.js';
import {
  fail,
  ok,
  resolveControlClient,
  takeFlagValue,
} from './shared.js';

interface EnsureOptions extends EnsureSurfaceRequest {
  json: boolean;
}

export const ensureCommand: Command = {
  name: 'ensure',
  usage: 'Usage: dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>\n',
  run: runEnsureCommand,
};

async function runEnsureCommand(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = parseEnsureArgs(args);
  if (!parsed.ok) return fail(parsed.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
    const response = await clientResult.value.ensureSurface(parsed.value);
    return ok(renderEnsureResponse(response, parsed.value.json));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function parseEnsureArgs(args: string[]): ParseResult<EnsureOptions> {
  const result: Omit<EnsureOptions, 'command'> & { command?: string } = {
    json: false,
    minimized: false,
  };
  let commandArgs: string[] | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      commandArgs = args.slice(index + 1);
      break;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--minimize') {
      result.minimized = true;
    } else if (arg === '--title') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.title = value.value;
      index += 1;
    } else if (arg === '--surface') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.surface = value.value;
      index += 1;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    } else {
      return { ok: false, message: `unexpected argument '${arg}' before --` };
    }
  }

  if (!commandArgs) {
    return { ok: false, message: 'dor ensure requires -- <command...>' };
  }
  const command = commandArgs.join(' ').trim();
  if (!command) {
    return { ok: false, message: 'dor ensure requires a command after --' };
  }

  return {
    ok: true,
    value: {
      command,
      json: result.json,
      minimized: result.minimized,
      surface: result.surface,
      title: result.title,
    },
  };
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
