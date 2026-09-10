/** Playwright's native CLI with Dormouse addressing and a shared browser pane. */
import { buildCommand } from '@stricli/core';
import type { BrowserBinding, CliOptions, CliResult, Command, DorCommandContext } from './types.js';
import { extractSessionFlags, resolveOpenTargetArgs, resolveBinaryPath, browserBinaryIsMissing, execBrowserProcess, isMissingBinaryError } from './browser-cli.js';
import { fail, requireControlClient, errorMessage, stringParser, callerWorkingDirectory } from './shared.js';

export const playwrightCommand: Command = {
  name: 'playwright',
  command: buildCommand<{ key?: string; session?: string; surface?: string }, string[], DorCommandContext>({
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
      },
      positional: { kind: 'array', parameter: { parse: stringParser, brief: 'Native Playwright CLI arguments.', placeholder: 'args' }, minimum: 0 },
    },
    func: async () => new Error('internal: playwright passthrough was not intercepted'),
  }),
};
const NO_BIND = new Set(['close', 'detach', 'close-all', 'kill-all', 'delete-data', 'list', 'show', 'install', 'install-browser']);
function missing(binary: string): CliResult {
  return fail(`playwright-cli is not installed (looked for '${binary}').\n\nInstall it with: npm i -g @playwright/cli\nOr set DORMOUSE_PLAYWRIGHT_BIN to its full path.`);
}
export async function runPlaywrightCli(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = extractSessionFlags(args.map(arg => arg === '-s' ? '--session' : arg.startsWith('-s=') ? `--session=${arg.slice(3)}` : arg));
  if (!parsed.ok) return fail(parsed.message.replaceAll('agent-browser', 'Playwright'));
  const flags = parsed.value;
  const client = requireControlClient(options);
  const nativeCommand = flags.rest.find(arg => !arg.startsWith('-'));
  const informational = flags.rest.some(arg => ['--help', '-h', '--version', '-v'].includes(arg));
  const mayBind = !!nativeCommand && !NO_BIND.has(nativeCommand) && !informational;
  const env = options.env ?? {};
  let binding: BrowserBinding = { session: flags.session ?? '', cwd: callerWorkingDirectory(undefined, env), binaryPath: resolveBinaryPath(env.DORMOUSE_PLAYWRIGHT_BIN ?? 'playwright-cli', env) };
  if ((flags.surface !== undefined || flags.key !== undefined) && !informational) {
    if (client instanceof Error) {
      if (flags.surface !== undefined) return fail(client.message);
    } else {
      if (!client.resolveBrowser) return fail('This Dormouse host does not support Playwright. Update Dormouse and retry.');
      try {
        const resolved = await client.resolveBrowser({ provider: 'playwright', ...(flags.surface ? { surface: flags.surface } : { key: flags.key, ...(mayBind ? { proposed: binding } : {}) }) });
        if (resolved.binding) binding = resolved.binding;
        else if (flags.surface) return fail('The surface has no Playwright session yet.');
      } catch (error) { return fail(errorMessage(error)); }
    }
  }
  const resolved = await resolveOpenTargetArgs(flags.rest, options, new Set(['open', 'goto']));
  if (!resolved.ok) return fail(resolved.message);
  const rest = resolved.value;
  const binary = binding.binaryPath ?? env.DORMOUSE_PLAYWRIGHT_BIN ?? 'playwright-cli';
  const binaryPath = resolveBinaryPath(binary, env);
  if (!options.execPlaywright && browserBinaryIsMissing(binary, env, binaryPath)) return missing(binary);
  const exec = options.execPlaywright ?? execBrowserProcess;
  try {
    const result = await exec(binary, [`--session=${binding.session}`, ...rest], binding.cwd);
    if (result.exitCode === 0 && mayBind && !(client instanceof Error)) {
      try {
        if (!client.browserSurface) throw new Error('This Dormouse host does not support Playwright.');
        await client.browserSurface({ provider: 'playwright', key: flags.key, session: binding.session, cwd: binding.cwd, ...(binaryPath ? { binaryPath } : {}) });
      } catch (error) { result.stderr += `Warning: could not open the Dormouse browser surface: ${errorMessage(error)}\n`; }
    }
    return result;
  } catch (error) { return isMissingBinaryError(error) ? missing(binary) : fail(errorMessage(error)); }
}
