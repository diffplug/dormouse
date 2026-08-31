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
  stringParser,
  writeStderr,
  writeStdout,
} from './shared.js';

interface ToolFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly fresh?: boolean;
  readonly surface?: string;
  readonly cwd?: string;
}

// A named tool waits on the same shell-integration handshake `dor ensure` does,
// plus a `dormouse.yml` read; both are bounded well under this.
const TOOL_TIMEOUT_MS = 20_000;

const FLAGS_WITH_VALUES = new Set(['--cwd', '--surface']);
const BOOLEAN_FLAGS = new Set(['--json', '--minimize', '--fresh']);

/**
 * `dor tool` takes either a registered name or a `--` command tail, never both.
 * stricli cannot express that, so the shape is checked before it parses — the
 * same pre-parse contract `dor ensure` uses. Keep the flag lists above in sync
 * with `parameters.flags`.
 */
export function validateToolArgs(args: string[]): ParseResult<void> {
  const delimiterIndex = args.indexOf('--');
  const head = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);

  const positionals: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = head[index + 1];
      if (!value || value.startsWith('-')) return { ok: false, message: `${arg} requires a value` };
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, message: `unknown option '${arg}'` };
    positionals.push(arg);
  }

  if (delimiterIndex === -1) {
    if (positionals.length === 0) {
      return { ok: false, message: 'dor tool requires a tool name or -- <command...>' };
    }
    // Arguments for a named tool wait for phase C, where substitution has to
    // reach the dedupe key; accepting them now would key a per-target tool on
    // its name alone and collapse every target into one pane.
    if (positionals.length > 1) {
      return { ok: false, message: `dor tool <name> takes no arguments (got '${positionals[1]}')` };
    }
    return { ok: true, value: undefined };
  }

  // `dor tool <name> -- <command>` would leave two sources for one command.
  if (positionals.length > 0) {
    return { ok: false, message: `unexpected argument '${positionals[0]}' before --` };
  }
  if (args.slice(delimiterIndex + 1).join(' ').trim() === '') {
    return { ok: false, message: 'dor tool requires a command after --' };
  }
  return { ok: true, value: undefined };
}

export const toolCommand: Command = {
  name: 'tool',
  preParse: validateToolArgs,
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor tool [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path]<TO-EOL>',
        '  dor tool [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] <name>\n  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] -- <command>...\n',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor tool [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path]<TO-EOL>',
        '  dor tool [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] <name>\n  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] -- <command>...\n',
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

Two forms. \`dor tool <name>\` runs an entry from the nearest dormouse.yml, walking up from the working directory. \`dor tool -- <command>\` designates any command as a tool without a registry entry. A named tool takes no extra arguments yet.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every \`dor tool -- <command>\` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve the repo in Dormouse itself. An unapproved repo fails with a message rather than prompting in the terminal; approve it in the app and run the command again. Declining is remembered too.

Where the tool lands depends on the caller. Typed on its own at a shell prompt, it takes over that pane, because typing a command at a prompt is how a terminal works. From a script, from an agent, from a compound command line, or when the pane is busy or already a tool, it splits without taking focus and prints the new surface's handle.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"

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
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        fresh: { kind: 'boolean', brief: 'Ignore a declared key and always create.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref' },
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
  // `--` is discarded by stricli, so the two forms are indistinguishable from
  // the positionals alone; `hasArgumentEscape` is captured pre-parse for it.
  const named = !this.hasArgumentEscape;
  if (named && rest.length === 0) {
    return new Error('dor tool requires a tool name or -- <command...>');
  }

  const client = requireControlClient(this.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;

  try {
    const response = await client.toolSurface({
      ...(named ? { name: rest[0] } : { command: rest }),
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
