/** Playwright's native CLI with Dormouse addressing and a shared browser pane. */
import { buildCommand } from '@stricli/core';
import { BROWSER_PROVIDERS, PLAYWRIGHT_BIN_ENV, type BrowserAutomationProvider } from 'dor-lib-common';
import { runBrowserCli, type BrowserCliDescriptor } from './browser-cli.js';
import type { CliOptions, CliResult, Command, DorCommandContext } from './types.js';
import { stringParser, workspaceFlag } from './shared.js';

export const playwrightCommand: Command = {
  name: 'playwright' satisfies BrowserAutomationProvider,
  command: buildCommand<{ key?: string; session?: string; surface?: string; workspace?: string }, string[], DorCommandContext>({
    docs: {
      brief: 'Drive a browser surface via your Playwright CLI install (alias: dor pw).',
      fullDescription: `Forwards native playwright-cli commands to your installed @playwright/cli.
Install: npm i -g @playwright/cli
Override the executable with DORMOUSE_PLAYWRIGHT_BIN.

--key names one Playwright browser in this Dormouse workspace (default: default).
The first command fixes its working directory; later commands, including relative
file paths, run there. --session (or -s) selects a native session instead.
--surface drives an existing Playwright pane, including one opened from the GUI.
These three identities are mutually exclusive. Other flags belong to Playwright.

open and goto accept URLs, host:port, :port, or a terminal surface handle.
Launch once with open, then navigate with goto: Playwright's open restarts the
browser, dropping its tabs and cookies, while goto navigates the current tab.
Chromium sessions can be viewed and controlled in Dormouse.

Examples:
  dor pw --key app open :5173
  dor pw --key app goto http://localhost:5173/settings
  dor pw --key app snapshot
  dor pw --key app click e15
  dor playwright --key docs open surface:3
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

const PLAYWRIGHT: BrowserCliDescriptor = {
  provider: 'playwright',
  sessionNoun: 'a Playwright session name',
  sessionAliases: ['-s'],
  // `open` restarts the browser, `goto` navigates the current tab.
  navigationVerbs: new Set(['open', 'goto']),
  // Native commands that never create or resurrect a Surface
  // (docs/specs/dor-cli.md → "Browser Surface Addressing").
  noBind: new Set(['close', 'detach', 'close-all', 'kill-all', 'delete-data', 'list', 'show', 'install', 'install-browser']),
  informational: new Set(['--help', '-h', '--version', '-v']),
  // A Playwright session lives in its CLI project scope: every command runs in
  // the binding's directory, with the executable that first opened it.
  projectScoped: true,
  missingBinaryMessage: (binary) => `playwright-cli is not installed (looked for '${binary}').\n\nInstall it with: ${BROWSER_PROVIDERS.playwright.installHint}\nOr set ${PLAYWRIGHT_BIN_ENV} to its full path.`,
  exec: (options) => options.execPlaywright,
};

export function runPlaywrightCli(args: string[], options: CliOptions): Promise<CliResult> {
  return runBrowserCli(PLAYWRIGHT, args, options);
}
