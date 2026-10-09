/** `dor tool` — run a command as a Dor Tool (`docs/specs/dor-tool.md`). */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  ParseResult,
  ToolListResponse,
  ToolSurfaceRequest,
} from './types.js';
import {
  callerWorkingDirectory,
  errorMessage,
  renderPrintableJson,
  requireControlClient,
  scanPreDelimiterArgs,
  stringParser,
  workspaceFlag,
  workspaceParam,
  writeStderr,
  writeStdout,
} from './shared.js';
import { printableExact, renderToolResponse } from './terminal-text.js';

interface ToolFlags {
  readonly list?: boolean;
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
export const TOOL_TIMEOUT_MS = 20_000;

// Keep in sync with `parameters.flags`.
const FLAGS_WITH_VALUES = new Set(['--cwd', '--surface', '--workspace']);
const BOOLEAN_FLAGS = new Set(['--list', '--json', '--minimize', '--fresh', '--global']);

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

  if ((delimiterIndex === -1 ? args : args.slice(0, delimiterIndex)).includes('--list')) {
    if (delimiterIndex !== -1 || positionals.length > 0) return { ok: false, message: '--list takes no tool name or command' };
    return { ok: true, value: undefined };
  }

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
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--workspace ref] [--cwd path]<TO-EOL>',
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref] <name> [args...]\n  dor tool [--json] [--minimize] [--surface handle] [--cwd path] [--workspace ref] -- <command>...\n  dor tool --list [--global] [--cwd path] [--json]\n',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--workspace ref] [--cwd path]<TO-EOL>',
        '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref] <name> [args...]\n  dor tool [--json] [--minimize] [--surface handle] [--cwd path] [--workspace ref] -- <command>...\n  dor tool --list [--global] [--cwd path] [--json]\n',
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

Approving an upstream covers any folder whose git config names that upstream, every worktree and clone of the repo included. Approving a folder covers that checkout only, which is what you want for a branch you have not read.

Where the tool lands: typed alone at a prompt in a visible, integrated plain terminal whose directory is the tool's, it takes over that pane — no split, same surface, same scrollback — and reports "takeover". Anything else — an agent's invocation, a compound line, a pane with a helper, --minimize, --surface, --cwd elsewhere — splits without taking focus and prints the new surface's handle. The pane remains a Tool after its command exits: another invocation from that prompt splits unless it matches a keyed Tool; the same keyed Tool reruns in place. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

--list runs nothing: it prints the Tools \`dor tool <name>\` would find from the working directory — the nearest project dormouse.yml and whether you have approved it, then the user file. Each Tool shows its command, render, port strategy, and whether it has a key, then the comment block directly above its entry, which is where a Tool is documented. A user Tool that a project Tool of the same name hides is marked shadowed. --global lists only user Tools.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"
  takeover surface:1  "pnpm storybook"

  project  /Users/me/projects/site/dormouse.yml  [approved]
    storybook  "pnpm storybook"  [iframe]  [port auto]  [keyed]
        The component catalog, for a human to look at.
  user  /Users/me/.config/dormouse/dormouse.yml  [not found]

JSON output:
  {
    "status": "created",
    "surface_id": "surface:3",
    "command": "pnpm storybook",
    "cwd": "/Users/me/projects/site",
    "minimized": false,
    "key": ["storybook", "/Users/me/projects/site"]
  }

  {
    "project": { "path": "/Users/me/projects/site/dormouse.yml", "approved": true },
    "user": { "path": "/Users/me/.config/dormouse/dormouse.yml", "found": false },
    "tools": [
      {
        "name": "storybook",
        "scope": "project",
        "run": "pnpm storybook",
        "render": "iframe",
        "port": "auto",
        "keyed": true,
        "description": "The component catalog, for a human to look at.",
        "shadowed": false
      }
    ]
  }`,
    },
    parameters: {
      flags: {
        global: { kind: 'boolean', brief: 'Resolve only user-global tools.', optional: true, withNegated: false },
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        fresh: { kind: 'boolean', brief: 'Ignore a declared key and always create.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'handle' },
        workspace: workspaceFlag,
        cwd: { kind: 'parsed', parse: stringParser, brief: 'Working directory for the tool file and the command.', optional: true, placeholder: 'path' },
        list: { kind: 'boolean', brief: 'List the declared Tools instead of running one.', optional: true, withNegated: false },
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
  if (flags.list === true) {
    // It resolves like a launch but places nothing.
    if (flags.minimize || flags.fresh || flags.surface !== undefined || flags.workspace !== undefined) {
      return new Error('--list takes only --global, --cwd, and --json');
    }
    return listTools(this, flags);
  }
  // `validateToolArgs` already accepted this argv, so the walk cannot fail.
  const head = headPositionals(this.commandArgs);
  const named = head.ok && head.value.length > 0;
  if (named && rest.length === 0) {
    return new Error('dor tool requires a tool name or -- <command...>');
  }

  return dispatchToolSurface(this, {
    ...(named ? { name: rest[0], args: rest.slice(1), global: flags.global === true } : { command: rest }),
    ...workspaceParam(flags.workspace),
    fresh: flags.fresh === true,
    minimized: flags.minimize === true,
    surface: flags.surface,
    cwd: callerWorkingDirectory(flags.cwd, this.options),
  }, flags.json === true);
}

/** The launch round trip `dor tool` and `dor open` share: one Tool request in,
 *  its handle out. */
export async function dispatchToolSurface(
  context: DorCommandContext, request: ToolSurfaceRequest, json: boolean,
): Promise<void | Error> {
  const client = requireControlClient(context.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;
  try {
    const response = await client.toolSurface(request);
    // Lint output is advisory and must not pollute a `--json` parse.
    for (const warning of response.warnings ?? []) writeStderr(context, `${printableExact(warning)}\n`);
    writeStdout(context, renderToolResponse(response, json));
    return undefined;
  } catch (error) {
    // Host errors can echo paths and repo text.
    return new Error(printableExact(errorMessage(error)));
  }
}


async function listTools(context: DorCommandContext, flags: ToolFlags): Promise<void | Error> {
  const client = requireControlClient(context.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;
  try {
    const listing = await client.toolList({ cwd: callerWorkingDirectory(flags.cwd, context.options), global: flags.global === true });
    const { warnings, ...shown } = listing;
    for (const warning of warnings) writeStderr(context, `${printableExact(warning)}\n`);
    writeStdout(context, flags.json === true ? renderPrintableJson(shown) : renderToolList(listing, flags.global === true));
    return undefined;
  } catch (error) {
    return new Error(printableExact(errorMessage(error)));
  }
}

/** Grouped by file, each Tool's description indented beneath it. Every field is
 *  repo text bound for a terminal, so each passes `printableExact`. `--global` never
 *  looked for a project, so it reports none. */
function renderToolList(listing: ToolListResponse, global: boolean): string {
  const lines: string[] = [];
  if (listing.project) lines.push(`project  ${printableExact(listing.project.path)}  [${listing.project.approved ? 'approved' : 'not approved'}]`);
  else if (!global) lines.push('project  [no dormouse.yml found]');
  const tool = (entry: ToolListResponse['tools'][number]) => {
    lines.push(`  ${[
      printableExact(entry.name),
      printableExact(JSON.stringify(entry.run)),
      `[${entry.render}]`,
      `[port ${entry.port}]`,
      ...(entry.keyed ? ['[keyed]'] : []),
      ...(entry.shadowed ? ['[shadowed]'] : []),
    ].join('  ')}`);
    for (const line of entry.description?.split('\n') ?? []) lines.push(line ? `      ${printableExact(line)}` : '');
  };
  listing.tools.filter(entry => entry.scope === 'project').forEach(tool);
  lines.push(`user  ${printableExact(listing.user.path)}${listing.user.found ? '' : '  [not found]'}`);
  listing.tools.filter(entry => entry.scope === 'user').forEach(tool);
  return `${lines.join('\n')}\n`;
}
