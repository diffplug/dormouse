/** Private `surface.ensure` wiring for command+cwd idempotency. */

import { resolve as resolvePath } from 'node:path';
import { buildCommand } from '@stricli/core';
import type {
  CliEnv,
  Command,
  DorCommandContext,
  EnsureSurfaceResponse,
} from './types.js';
import {
  errorMessage,
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface EnsureFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly restart?: boolean;
  readonly surface?: string;
  readonly cwd?: string;
}

// `--restart` makes the host block until a server is interrupted and respawned,
// which can outlast the client's default 5s request timeout. Give that one
// command plenty of headroom.
const RESTART_TIMEOUT_MS = 60_000;

// When ensure *creates* a surface, the host waits for the new shell to report OSC
// 633 integration so it can warn if the command won't be trackable. That wait can
// run to ~15s on a shell that never integrates, outlasting the default 5s. Matched
// surfaces still respond instantly; this only raises the ceiling for the slow case.
const ENSURE_TIMEOUT_MS = 20_000;

export const ensureCommand: Command = {
  name: 'ensure',
  helpPatches: [
    {
      scope: 'root',
      findReplace: [
        '  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path]<TO-EOL>',
        '  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path] -- <command>...\n',
      ],
    },
    {
      scope: 'command-usage',
      findReplace: [
        '  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path]<TO-EOL>',
        '  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path] -- <command>...\n',
      ],
    },
    {
      scope: 'command-detail',
      remove: ['\nARGUMENTS<TO-EOL><LS>command...<TO-EOL>'],
    },
  ],
  command: buildCommand<EnsureFlags, string[], DorCommandContext>({
    docs: {
      brief: 'Ensure one surface is running a command.',
      fullDescription: `Ensures one surface in the current workspace is running the given command at the given path. If it's already running, no-op. If it isn't, then it creates a split and runs the command.

ensure never changes focus. Whether it reuses a match, restarts one, or creates a new split, the surface you ran it from keeps focus — a newly created surface (visible or minimized) starts in the background.

Matching uses the command each shell reports it is running via Dormouse shell integration (OSC 633), not process inspection. This captures the typed command (\`npm run dev\`), not the forked child process (\`node .../vite\`), and works for shells the user started by hand as well as shells Dormouse started. The match is exact: \`npm run dev\` and \`npm run dev --host\` are different commands and get separate surfaces.

ensure requires that integration: a surface can only be matched, reused, or restarted if its shell reports its command. So if the shell has no OSC 633 integration (e.g. cmd.exe), ensure fails with an error rather than starting an untrackable surface — run it from a shell with integration, such as Git Bash or PowerShell.

A surface matches only while the command is live. Once the command exits and the shell returns to its prompt, the surface no longer matches; the next ensure causes a fresh split rather than reusing the idle shell. Minimized surfaces participate in matching. Closed/killed surfaces do not.

Two surfaces running the same command in different working directories are distinct (e.g. the same dev server in two worktrees). Both keep running; ensure never collapses them.

--cwd sets the working directory used both for matching and for the new command. If omitted, Dormouse uses the directory dor was invoked from. The path is resolved to an absolute path and matched exactly; symlinks are not resolved, so two routes to the same directory are treated as distinct.

--minimize applies only when creating a new surface; it does not minimize an existing match.

--restart applies only to an already-running match: it interrupts the live command (Ctrl+C), waits for the shell to return to its prompt, then re-runs the command in place and blocks until the command is live again. A restarted surface keeps its minimized/visible state. If no surface is running the command, --restart behaves like a plain ensure and creates one.

--surface selects the surface to split only when creating a new surface. If omitted, Dormouse uses the same caller/focused fallback as dor split.

Text output:
  created surface:3  "npm run dev"
  existing surface:3  "npm run dev"
  restarted surface:3  "npm run dev"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "command": "npm run dev",
    "cwd": "/Users/me/projects/site",
    "minimized": false
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        restart: { kind: 'boolean', brief: 'Restart a matching surface in place.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref|index' },
        cwd: { kind: 'parsed', parse: stringParser, brief: 'Working directory for matching and for the new command.', optional: true, placeholder: 'path' },
      },
      positional: {
        kind: 'array',
        minimum: 1,
        parameter: { parse: stringParser, brief: 'Command to run.', placeholder: 'command' },
      },
    },
    func: runEnsureCommand,
  }),
};

async function runEnsureCommand(this: DorCommandContext, flags: EnsureFlags, ...commandArgs: string[]): Promise<void | Error> {
  if (commandArgs.length === 0) {
    return new Error('dor ensure requires a command after --');
  }

  const client = requireControlClient(this.options, flags.restart === true ? RESTART_TIMEOUT_MS : ENSURE_TIMEOUT_MS);
  if (client instanceof Error) return client;

  try {
    const response = await client.ensureSurface({
      command: commandArgs,
      minimized: flags.minimize === true,
      restart: flags.restart === true,
      surface: flags.surface,
      cwd: callerWorkingDirectory(flags.cwd, this.options.env),
    });
    writeStdout(this, renderEnsureResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

// Git Bash exports PWD as a POSIX path (`/c/Users/...`). On Windows, resolvePath
// reads the leading `/c` as a folder under the current drive's root and mangles it
// to `C:\c\Users\...`, which then matches no surface. Fold the MSYS drive form to a
// native Windows drive first. No-op off win32 and for paths that already carry a
// drive letter (e.g. `C:/Users/...`, which some MSYS builds export instead).
export function msysToWindowsCwd(pwd: string, platform: string): string {
  if (platform !== 'win32') return pwd;
  const match = pwd.match(/^\/([A-Za-z])\/(.*)$/);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}` : pwd;
}

// The host has no idea where `dor` was launched, so the caller's directory must
// travel in the request. Prefer the shell's PWD (injectable, matches what the
// user sees) and fall back to the process cwd. resolvePath canonicalizes both
// the default and a relative/absolute --cwd into one absolute path the host can
// key on.
function callerWorkingDirectory(flag: string | undefined, env: CliEnv | undefined): string {
  const base = msysToWindowsCwd(env?.PWD ?? process.cwd(), process.platform);
  return resolvePath(base, flag ?? '.');
}

function renderEnsureResponse(response: EnsureSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      command: response.command,
      cwd: response.cwd,
      minimized: response.minimized,
    });
  }

  return `${response.status} ${response.surfaceRef}  ${JSON.stringify(response.command)}\n`;
}
