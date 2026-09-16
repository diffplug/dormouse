/** `dor tool` — run a command as a Dor Tool (`docs/specs/dor-tool.md`). */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  ToolSurfaceResponse,
} from './types.js';
import {
  callerWorkingDirectory,
  errorMessage,
  renderJson,
  requireControlClient,
  scanPreDelimiterArgs,
  stringParser,
  workspaceFlag,
  workspaceParam,
  writeStderr,
  writeStdout,
} from './shared.js';

interface ToolFlags {
  readonly json?: boolean;
  readonly global?: boolean;
  readonly minimize?: boolean;
  readonly fresh?: boolean;
  readonly surface?: string;
  readonly cwd?: string;
  readonly workspace?: string;
}

// A named tool waits on the same shell-integration handshake `dor ensure` does,
// plus a `dormouse.yml` read; both are bounded well under this.
const TOOL_TIMEOUT_MS = 20_000;

// Keep in sync with `parameters.flags`.
const FLAGS_WITH_VALUES = new Set(['--cwd', '--surface', '--workspace']);
const BOOLEAN_FLAGS = new Set(['--json', '--minimize', '--fresh', '--global']);

/**
 * `dor tool` takes a registered name with inputs, or a nameless `--` command tail.
 * stricli cannot express that, so the shape is checked before it parses — the
 * same pre-parse contract `dor ensure` uses.
 */
export function validateToolArgs(args: readonly string[]): ParseResult<void> {
  const delimiterIndex = args.indexOf('--');
  const head = headPositionals(args);
  if (!head.ok) return head;
  const { value: positionals } = head;

  if (delimiterIndex === -1) {
    if (positionals.length === 0) {
      return { ok: false, message: 'dor tool requires a tool name or -- <command...>' };
    }
    return { ok: true, value: undefined };
  }

  if (positionals.length > 0) return { ok: true, value: undefined };
  if (args.slice(0, delimiterIndex).includes('--global')) return { ok: false, message: '--global requires a named tool' };
  if (args.slice(delimiterIndex + 1).join(' ').trim() === '') {
    return { ok: false, message: 'dor tool requires a command after --' };
  }
  return { ok: true, value: undefined };
}

/** The positionals before `--`: a tool name and its dash-free inputs. Non-empty
 *  means the named form; stricli discards the separator, so this is the one
 *  walk that can tell `dor tool viewer -- --flag` from `dor tool -- viewer`. */
function headPositionals(args: readonly string[]): ParseResult<string[]> {
  const delimiterIndex = args.indexOf('--');
  return scanPreDelimiterArgs(delimiterIndex === -1 ? args : args.slice(0, delimiterIndex), {
    booleans: BOOLEAN_FLAGS, valued: FLAGS_WITH_VALUES, positionals: 'collect',
  });
}

export const toolCommand: Command = {
  name: 'tool',
  preParse: validateToolArgs,
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--workspace ref] [--cwd path]<TO-EOL>',
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] [--workspace ref] <name> [args...]\n  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] [--workspace ref] -- <command>...\n',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--workspace ref] [--cwd path]<TO-EOL>',
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] [--workspace ref] <name> [args...]\n  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] [--workspace ref] -- <command>...\n',
      ],
    },
    {
      scope: 'command-detail',
      remove: ['\nARGUMENTS<TO-EOL><LS>name<TO-EOL>'],
    },
  ],
  command: buildCommand<ToolFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Run a command as a Dor Tool.',
      fullDescription: `Runs a command in a new surface and watches the ports it opens. When the command starts serving, the surface grows a browser in place — same surface, same id, no second pane — and the pane flips to it with the terminal behind the header's far-left chip. When the command exits the browser retires and the pane flips back.

Two forms. \`dor tool <name>\` runs an entry from the nearest dormouse.yml, walking up from the working directory, falling back to user-global tools. --global skips project discovery. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml. \`dor tool -- <command>\` designates any command as a tool without a registry entry. Named tools accept arguments: \`dor tool <name> [args...]\`, or \`dor tool <name> -- <args...>\` for arguments beginning with a dash. Use an argument-list \`run\` in the configuration to accept inputs.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every \`dor tool -- <command>\` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A project dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve it in Dormouse itself. For an unapproved repo the surface is created and reports "pending": its pane shows what would run and waits for you to allow the upstream, allow just this folder, or close it. Nothing from the repo runs until you choose, and declining records nothing.

Approving an upstream covers every worktree and clone of that repo. Approving a folder covers that checkout only, which is what you want for a branch you have not read.

Where the tool lands: typed alone at a prompt in a visible, integrated plain terminal whose directory is the tool's, it takes over that pane — no split, same surface, same scrollback — and reports "takeover". Anything else — an agent's invocation, a compound line, a pane with a helper, --minimize, --surface, --cwd elsewhere — splits without taking focus and prints the new surface's handle. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"
  takeover surface:1  "pnpm storybook"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "command": "pnpm storybook",
    "cwd": "/Users/me/projects/site",
    "minimized": false,
    "key": ["storybook", "/Users/me/projects/site"]
  }`,
    },
    parameters: {
      flags: {
        global: { kind: 'boolean', brief: 'Resolve only user-global tools.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        fresh: { kind: 'boolean', brief: 'Ignore a declared key and always create.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref' },
        workspace: workspaceFlag,
        cwd: { kind: 'parsed', parse: stringParser, brief: 'Working directory for the tool file and the command.', optional: true, placeholder: 'path' },
      },
      positional: {
        kind: 'array',
        minimum: 0,
        parameter: { parse: stringParser, brief: 'Registered tool name.', placeholder: 'name' },
      },
    },
    func: runToolCommand,
  }),
};

async function runToolCommand(this: DorCommandContext, flags: ToolFlags, ...rest: string[]): Promise<void | Error> {
  // `validateToolArgs` already accepted this argv, so the walk cannot fail.
  const head = headPositionals(this.commandArgs);
  const named = head.ok && head.value.length > 0;
  if (named && rest.length === 0) {
    return new Error('dor tool requires a tool name or -- <command...>');
  }

  const client = requireControlClient(this.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;

  try {
    const response = await client.toolSurface({
      ...(named ? { name: rest[0], args: rest.slice(1), global: flags.global === true } : { command: rest }),
      ...workspaceParam(flags.workspace),
      fresh: flags.fresh === true,
      minimized: flags.minimize === true,
      surface: flags.surface,
      cwd: callerWorkingDirectory(flags.cwd, this.options.env),
    });
    // Lint output is advisory and must not pollute a `--json` parse.
    for (const warning of response.warnings ?? []) writeStderr(this, `${warning}\n`);
    writeStdout(this, renderToolResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function renderToolResponse(response: ToolSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      command: response.command,
      cwd: response.cwd,
      minimized: response.minimized,
      key: response.key,
    });
  }
  return `${response.status} ${response.surfaceRef}  ${JSON.stringify(response.command)}\n`;
}
