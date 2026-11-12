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
  cwdParser,
  launchDirectory,
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
import { approvalTag, printableExact, renderToolResponse, toolRunText, toolTags } from './terminal-text.js';
import { runToolPicker } from './tool-picker.js';

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
// plus a `dormouse.yml` read; both are bounded well under this. That bounds
// this launch only: launches share one host queue, each held until its command
// reports, so one queued behind others can outlast it.
export const TOOL_TIMEOUT_MS = 20_000;

// Keep in sync with `parameters.flags`.
const FLAGS_WITH_VALUES = new Set(['--cwd', '--surface', '--workspace']);
const BOOLEAN_FLAGS = new Set(['--list', '--json', '--minimize', '--fresh', '--global']);

/** stricli's usage line, which the help replaces with one per form. */
const STRICLI_USAGE = '  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--workspace ref] [--cwd path]<TO-EOL>';
const LAUNCH_FLAGS = '[--global] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref]';
const USAGE = [
  `  dor tool ${LAUNCH_FLAGS} <name> [args...]`,
  '  dor tool [--json] [--minimize] [--surface handle] [--cwd path] [--workspace ref] -- <command>...',
  `  dor tool ${LAUNCH_FLAGS}`,
  '  dor tool --list [--global] [--cwd path] [--json]',
].map(line => `${line}\n`).join('');

/**
 * `dor tool` takes a registered name with inputs, a nameless `--` command tail,
 * or nothing, which picks or lists a Tool. stricli cannot express that, so the
 * shape is checked before it parses — the same pre-parse contract `dor ensure`
 * uses.
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

  // Bare, it picks or lists a Tool, and only `runToolCommand` knows which.
  if (delimiterIndex === -1) return { ok: true, value: undefined };

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
    { scope: 'root', findReplace: [STRICLI_USAGE, USAGE] },
    { scope: 'command-usage', findReplace: [STRICLI_USAGE, USAGE] },
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

Where the tool lands: typed alone at a prompt in a visible, integrated plain terminal whose directory is the tool's, it takes over that pane — no split, same surface, same scrollback — and reports "takeover". Anything else — an agent's invocation, a compound line, a pane with a helper, --minimize, --surface, --cwd elsewhere — splits without taking focus and prints the new surface's handle. Once the command exits the pane is a plain terminal again; a later invocation from its prompt takes it over afresh. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

--list runs nothing: it prints the Tools \`dor tool <name>\` would find from the working directory — the nearest project dormouse.yml and whether you have approved it, then the user file. Each Tool shows its command, render, port strategy, and whether it has a key, then the comment block directly above its entry, which is where a Tool is documented. A user Tool that a project Tool of the same name hides is marked shadowed. A user Tool imported from another dormouse.yml shows that file, and one that does not resolve is marked broken with the reason. --global lists only user Tools.

Without a name or --, in an interactive terminal, a fuzzy finder lists the Tools --list would. Type to filter, ↑/↓ or the mouse to select, Enter or a double-click to run. Beside the list — or on one status line when the terminal is narrower than 100 columns — it shows the highlighted Tool's tags, file, and description. A shadowed user Tool runs as --global would run it. Esc or Ctrl+C cancels, exiting 1 silently. The other flags apply to the chosen Tool. With no Tool declared, it prints the listing instead. Without a terminal, or with --json, it prints what --list prints, unless --minimize, --fresh, --surface, or --workspace asks for a launch.

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
        cwd: { kind: 'parsed', parse: cwdParser, brief: 'Working directory for the tool file and the command.', optional: true, placeholder: 'path' },
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
  // A listing resolves like a launch but places nothing.
  const placing = flags.minimize || flags.fresh || flags.surface !== undefined || flags.workspace !== undefined;
  if (flags.list === true) {
    if (placing) return new Error('--list takes only --global, --cwd, and --json');
    return listTools(this, flags);
  }
  if (!this.commandArgs.includes('--') && rest.length === 0) return pickTool(this, flags, placing);
  // `validateToolArgs` already accepted this argv, so the walk cannot fail.
  const head = headPositionals(this.commandArgs);
  const named = head.ok && head.value.length > 0;
  const placement = launchPlacement(this, flags);
  if (placement instanceof Error) return placement;
  return dispatchToolSurface(this, {
    ...(named ? { name: rest[0], args: rest.slice(1), global: flags.global === true } : { command: rest }),
    ...placement,
  }, flags.json === true);
}

function launchPlacement(context: DorCommandContext, flags: ToolFlags) {
  const cwd = launchDirectory(flags.cwd, context.options);
  if (cwd instanceof Error) return cwd;
  return {
    ...workspaceParam(flags.workspace),
    fresh: flags.fresh === true,
    minimized: flags.minimize === true,
    surface: flags.surface,
    cwd,
  };
}

/** Bare `dor tool`: a person at a terminal picks a Tool to run; anything else
 *  gets the listing. */
async function pickTool(context: DorCommandContext, flags: ToolFlags, placing: boolean): Promise<void | Error> {
  const { terminal } = context.options;
  if (!terminal || flags.json === true) {
    // A placement flag means the caller meant to launch something.
    return placing ? new Error('dor tool requires a tool name or -- <command...>') : listTools(context, flags);
  }
  // Checked before the picker opens: a pick is a launch, and its --cwd must exist.
  const placement = launchPlacement(context, flags);
  if (placement instanceof Error) return placement;
  const listing = await readToolList(context, flags);
  if (listing instanceof Error) return listing;
  if (listing.tools.length === 0) {
    printToolList(context, listing, flags);
    writeStdout(context, 'Declare a Tool in either file; dor skill shows how.\n');
    return undefined;
  }
  // The launch prints the chosen Tool's own warnings.
  const choice = await runToolPicker({ terminal, listing, home: context.options.env?.HOME ?? context.options.host.homedir() });
  // A cancel runs nothing and prints nothing, but is not a success.
  if (!choice) {
    context.process.exitCode = 1;
    return undefined;
  }
  return dispatchToolSurface(context, {
    // A shadowed user Tool is the one chosen, so the project's must not run.
    name: choice.name, args: [], global: flags.global === true || choice.shadowed,
    ...placement,
  }, false);
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
  const listing = await readToolList(context, flags);
  if (listing instanceof Error) return listing;
  printToolList(context, listing, flags);
  return undefined;
}

async function readToolList(context: DorCommandContext, flags: ToolFlags): Promise<ToolListResponse | Error> {
  const client = requireControlClient(context.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;
  try {
    return await client.toolList({ cwd: callerWorkingDirectory(flags.cwd, context.options), global: flags.global === true });
  } catch (error) {
    return new Error(printableExact(errorMessage(error)));
  }
}

function printToolList(context: DorCommandContext, listing: ToolListResponse, flags: ToolFlags): void {
  const { warnings, ...shown } = listing;
  for (const warning of warnings) writeStderr(context, `${printableExact(warning)}\n`);
  writeStdout(context, flags.json === true ? renderPrintableJson(shown) : renderToolList(listing, flags.global === true));
}

/** Grouped by file, each Tool's description indented beneath it. Every field is
 *  repo text bound for a terminal, so each passes `printableExact`. `--global` never
 *  looked for a project, so it reports none. */
function renderToolList(listing: ToolListResponse, global: boolean): string {
  const lines: string[] = [];
  if (listing.project) lines.push(`project  ${printableExact(listing.project.path)}  ${approvalTag(listing.project.approved)}`);
  else if (!global) lines.push('project  [no dormouse.yml found]');
  const tool = (entry: ToolListResponse['tools'][number]) => {
    lines.push(`  ${[printableExact(entry.name), toolRunText(entry), ...toolTags(entry)].join('  ')}`);
    for (const line of entry.description?.split('\n') ?? []) lines.push(line ? `      ${printableExact(line)}` : '');
  };
  listing.tools.filter(entry => entry.scope === 'project').forEach(tool);
  lines.push(`user  ${printableExact(listing.user.path)}${listing.user.found ? '' : '  [not found]'}`);
  listing.tools.filter(entry => entry.scope === 'user').forEach(tool);
  return `${lines.join('\n')}\n`;
}
