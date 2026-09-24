/** Playwright's native CLI with Dormouse addressing and a shared browser pane. */
import { statSync } from 'node:fs';
import { buildCommand } from '@stricli/core';
import {
  browserBinaryIsMissing,
  isAllowedPlaywrightBinary,
  resolveBinaryPath,
  sessionForKey,
  DEFAULT_PLAYWRIGHT_BIN,
  PLAYWRIGHT_BIN_ENV,
} from 'dor-lib-common';
import {
  execBrowserProcess,
  extractSessionFlags,
  isMissingBinaryError,
  resolveOpenTargetArgs,
  type ResolvedSessionFlags,
} from './browser-cli.js';
import type {
  BrowserBinding,
  CliOptions,
  CliResult,
  Command,
  ControlClient,
  DorCommandContext,
  ParseResult,
} from './types.js';
import {
  callerWorkingDirectory,
  errorMessage,
  fail,
  requireControlClient,
  stringParser,
  workspaceFlag,
  workspaceParam,
} from './shared.js';

export const playwrightCommand: Command = {
  name: 'playwright',
  command: buildCommand<{ key?: string; session?: string; surface?: string; workspace?: string }, string[], DorCommandContext>({
    docs: {
      brief: 'Drive a browser surface via your Playwright CLI install (alias: dor pw).',
      fullDescription: `Forwards native playwright-cli commands to your installed @playwright/cli.
Install: npm i -g @playwright/cli
Override the executable with DORMOUSE_PLAYWRIGHT_BIN.

--key names one Playwright browser in this Dormouse workspace (default: default).
The first launch fixes its working directory; later commands, including relative
file paths, run there. --session (or -s) selects a native session instead.
--surface drives an existing Playwright pane, including one opened from the GUI.
These three identities are mutually exclusive. Other flags belong to Playwright.

open and goto accept URLs, host:port, :port, or a terminal surface handle.
Playwright's open restarts the browser; goto navigates the current tab.
Chromium sessions can be viewed and controlled in Dormouse.

Examples:
  dor pw open http://localhost:5173
  dor playwright --key app open surface:3
  dor pw snapshot
  dor pw click e15
  dor pw --surface surface:4 goto :5173`,
    },
    parameters: {
      flags: {
        key: { kind: 'parsed', parse: stringParser, optional: true, brief: 'Workspace browser key (default "default").', placeholder: 'name' },
        session: { kind: 'parsed', parse: stringParser, optional: true, brief: 'Raw Playwright session name (alias: -s).', placeholder: 'name' },
        surface: { kind: 'parsed', parse: stringParser, optional: true, brief: 'Existing Playwright surface handle.', placeholder: 'handle' },
        workspace: workspaceFlag,
      },
      positional: { kind: 'array', parameter: { parse: stringParser, brief: 'Native Playwright CLI arguments.', placeholder: 'args' }, minimum: 0 },
    },
    func: async () => new Error('internal: playwright passthrough was not intercepted'),
  }),
};

// Native commands, and flags on any command, that never create or resurrect a
// Surface (docs/specs/dor-cli.md → "Playwright Surface Addressing").
const NO_BIND = new Set(['close', 'detach', 'close-all', 'kill-all', 'delete-data', 'list', 'show', 'install', 'install-browser']);
const INFORMATIONAL_FLAGS = new Set(['--help', '-h', '--version', '-v']);

// Playwright's URL-navigation verbs: `open` restarts the browser, `goto`
// navigates the current tab.
const NAVIGATION_VERBS = new Set(['open', 'goto']);

function missing(binary: string): CliResult {
  return fail(`playwright-cli is not installed (looked for '${binary}').\n\nInstall it with: npm i -g @playwright/cli\nOr set ${PLAYWRIGHT_BIN_ENV} to its full path.`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

export async function runPlaywrightCli(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = extractSessionFlags(args, { sessionNoun: 'a Playwright session name', sessionAliases: ['-s'] });
  if (!parsed.ok) return fail(parsed.message);
  const flags = parsed.value;

  const nativeCommand = flags.rest.find((arg) => !arg.startsWith('-'));
  const informational = flags.rest.some((arg) => INFORMATIONAL_FLAGS.has(arg));
  const mayBind = nativeCommand !== undefined && !NO_BIND.has(nativeCommand) && !informational;

  const env = options.env ?? {};
  // An empty override is unset, as for `dor ab` and the host.
  const defaultBinary = env[PLAYWRIGHT_BIN_ENV] || DEFAULT_PLAYWRIGHT_BIN;
  const defaultBinaryPath = resolveBinaryPath(defaultBinary, env);
  const client = requireControlClient(options);

  // The caller's own binding, unless the host holds one for the key or Surface.
  // A `--surface` names no session until the host answers.
  let binding: BrowserBinding = {
    session: flags.session ?? (flags.key === undefined ? '' : sessionForKey(flags.key)),
    cwd: callerWorkingDirectory(undefined, env),
  };
  if (flags.session === undefined && !informational) {
    const proposed = mayBind ? { cwd: binding.cwd, binaryPath: defaultBinaryPath } : undefined;
    const resolved = await resolveBinding(flags, client, proposed);
    if (!resolved.ok) return fail(resolved.message);
    if (resolved.value) {
      binding = resolved.value;
      // A binding comes off saved pane params, so its directory can be gone (a
      // removed worktree). Say so, rather than let the spawn's ENOENT read as a
      // missing playwright-cli on every later command.
      if (binding.cwd !== undefined && !isDirectory(binding.cwd)) {
        return fail(`The directory this Playwright browser was first opened in no longer exists: ${binding.cwd}\nClose its Dormouse pane, or use another --key.`);
      }
    }
  }

  const resolvedRest = await resolveOpenTargetArgs(flags.rest, options, flags.workspace, NAVIGATION_VERBS);
  if (!resolvedRest.ok) return fail(resolvedRest.message);
  const rest = resolvedRest.value;

  // A binding's pinned executable replaces the caller's, but it comes back from
  // the host (and off a hand-editable session file), so it passes the same
  // allowlist the host spawns under or the caller's own runs instead — as it
  // also does once the pinned one is gone (an uninstall, a Node version
  // switch). Walk PATH only for one not resolved above.
  let pinned = isAllowedPlaywrightBinary(binding.binaryPath, env[PLAYWRIGHT_BIN_ENV]) ? binding.binaryPath : undefined;
  let replacedPin = '';
  if (pinned !== undefined && browserBinaryIsMissing(pinned, env, resolveBinaryPath(pinned, env))) {
    replacedPin = `Warning: this browser's playwright-cli (${pinned}) is gone; ran ${defaultBinaryPath ?? defaultBinary} instead.\n`;
    pinned = undefined;
  }
  const binary = pinned ?? defaultBinary;
  const binaryPath = binary === defaultBinary ? defaultBinaryPath : resolveBinaryPath(binary, env);
  if (options.execPlaywright === undefined && browserBinaryIsMissing(binary, env, binaryPath)) {
    return missing(binary);
  }
  const exec = options.execPlaywright ?? execBrowserProcess;
  try {
    // Spawn the resolved path, never the bare name (docs/specs/dor-cli.md ->
    // "Spawning External Binaries"): the spawn's cwd is the project directory.
    const result = await exec(binaryPath ?? binary, [`--session=${binding.session}`, ...rest], binding.cwd);
    result.stderr = replacedPin + result.stderr;
    if (result.exitCode === 0 && mayBind && !(client instanceof Error)) {
      try {
        await client.browserSurface({
          provider: 'playwright',
          key: flags.key,
          session: binding.session,
          cwd: binding.cwd,
          ...(binaryPath ? { binaryPath } : {}),
          ...workspaceParam(flags.workspace),
        });
      } catch (error) {
        result.stderr += `Warning: could not open the Dormouse browser surface: ${errorMessage(error)}\n`;
      }
    }
    return result;
  } catch (error) {
    return isMissingBinaryError(error) ? missing(binary) : fail(errorMessage(error));
  }
}

/**
 * The binding the host holds for a `--key` or `--surface` — one
 * `surface.resolveBrowser` round trip (docs/specs/dor-browser.md → Playwright
 * Renderer). `proposed` offers the caller's cwd and executable when the command
 * may bind a key's first launch; the host mints the session.
 *
 * - A key with no binding yet answers null, as does any key outside Dormouse:
 *   the caller namespaces it itself, so `dor pw` stays a passthrough with no
 *   control endpoint.
 * - A Surface needs a live control endpoint and a bound session; either
 *   missing fails the command before the binary runs.
 */
async function resolveBinding(
  flags: ResolvedSessionFlags,
  client: ControlClient | Error,
  proposed: Omit<BrowserBinding, 'session'> | undefined,
): Promise<ParseResult<BrowserBinding | null>> {
  if (client instanceof Error) {
    return flags.surface === undefined ? { ok: true, value: null } : { ok: false, message: client.message };
  }
  try {
    const { binding } = await client.resolveBrowser({
      provider: 'playwright',
      ...(flags.surface === undefined ? { key: flags.key, ...(proposed ? { proposed } : {}) } : { surface: flags.surface }),
      ...workspaceParam(flags.workspace),
    });
    if (!binding && flags.surface !== undefined) {
      return { ok: false, message: 'The surface has no Playwright session yet.' };
    }
    return { ok: true, value: binding ?? null };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
