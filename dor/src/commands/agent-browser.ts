/** `dor agent-browser` passthrough and Surface binding; see docs/specs/dor-cli.md and
 * docs/specs/dor-browser.md. `runCli` intercepts real invocations before
 * stricli so forwarded arguments are never parsed as dor flags. */

import { buildCommand } from '@stricli/core';
import {
  AGENT_BROWSER_BIN_ENV,
  BROWSER_PROVIDERS,
  DEFAULT_AGENT_BROWSER_BIN,
  streamStatusArgs,
  type BrowserAutomationProvider,
} from 'dor-lib-common';
import { runBrowserCli, type BrowserCliDescriptor } from './browser-cli.js';
import type { CliOptions, CliResult, Command, DorCommandContext } from './types.js';
import { stringParser, workspaceFlag } from './shared.js';

const INSTALL_HINT = BROWSER_PROVIDERS['agent-browser'].installHint;
const INSTALL_DOCS = 'https://agent-browser.dev';

/**
 * Clear, multi-line guidance shown when the user's agent-browser binary is
 * absent. `binary` is named only when it differs from the default, so a custom
 * DORMOUSE_AGENT_BROWSER_BIN that points nowhere still tells the user what was
 * looked for.
 */
function missingBinaryMessage(binary: string): string {
  const lookedFor = binary === DEFAULT_AGENT_BROWSER_BIN ? '' : ` (looked for '${binary}')`;
  return [
    `agent-browser is not installed${lookedFor}.`,
    '',
    'dor agent-browser drives your own agent-browser binary, which Dormouse never bundles.',
    'Install it, then re-run your command:',
    '',
    `    ${INSTALL_HINT}`,
    '',
    `More: ${INSTALL_DOCS}`,
    `Already installed? Make sure it's on your PATH, or set ${AGENT_BROWSER_BIN_ENV} to its full path.`,
  ].join('\n');
}

export const agentBrowserCommand: Command = {
  name: 'agent-browser' satisfies BrowserAutomationProvider,
  helpPatches: [
    {
      scope: 'root',
      findReplace: ['agent-browser [--key name] [--session name] [--surface handle]<TO-EOL>', 'agent-browser [--key name|--session name|--surface handle] [--workspace ref] [args...]\n'],
    },
    {
      scope: 'command-usage',
      findReplace: ['agent-browser [--key name] [--session name] [--surface handle]<TO-EOL>', 'agent-browser [--key name|--session name|--surface handle] [--workspace ref] [args...]\n'],
    },
  ],
  command: buildCommand<{ key?: string; session?: string; surface?: string; workspace?: string }, [...args: string[]], DorCommandContext>({
    docs: {
      brief: 'Drive a browser surface via your agent-browser install.',
      fullDescription: `Forwards all arguments verbatim to your own agent-browser binary and binds the session to a Dormouse browser surface.

dor intercepts exactly three mutually exclusive identity flags:
  --key <name>       Managed, workspace-scoped browser identity (default "default").
                     Maps to agent-browser session dormouse.<workspace>.<name>,
                     so the same key in another Workspace is another browser.
  --session <name>   Attach to a raw agent-browser session by its literal name.
  --surface <handle> Drive the browser Surface a handle names (surface:N,
                     surface:focused, a stable id, title:<title>). dor asks the
                     host which agent-browser session that Surface is bound to,
                     which is the only way to address a GUI-spawned session.

It also intercepts --workspace <ref>, which is not an identity: it says which
Workspace of this Window the browser Surface is opened in and which one a
handle resolves against (workspace:<n> or workspace:<name>).

Everything else — subcommands, flags, selectors — is agent-browser's own
command surface. The binary is resolved from PATH (override with
DORMOUSE_AGENT_BROWSER_BIN) and is never bundled; install it with:
  ${INSTALL_HINT}

Dormouse intercepts dor-embed-size to query or set the pane's browser viewport:
  dor agent-browser dor-embed-size --json
  dor agent-browser dor-embed-size 1440 900 --dpr 2
  dor agent-browser dor-embed-size --preset pane-sync

After a successful command, dor opens the browser surface bound to the session,
or reuses the one it already has. A playwright browser (render_mode playwright-*) is
driven with dor playwright --surface instead.

In an "open" command, dor also resolves a Dormouse target in place of a URL:
a schemeless host:port (and the ":<port>" localhost shorthand) defaults to
http:// rather than agent-browser's https://, and a terminal Surface handle
(surface:N, surface:self, surface:focused, or a stable id) resolves to the
dev-server URL that terminal owns via the host port scan.

Examples:
  dor agent-browser open http://localhost:5173        # key "default"
  dor agent-browser open localhost:5173                # → http://localhost:5173/
  dor agent-browser open :5173                         # → http://localhost:5173/
  dor agent-browser open surface:3                     # open the port terminal surface:3 owns
  dor agent-browser --key storybook open http://localhost:6006
  dor agent-browser click @e3                          # drives key "default"
  dor agent-browser --key storybook reload             # drives key "storybook"
  dor agent-browser --surface surface:4 click @e3      # drives whatever surface:4 is bound to`,
    },
    parameters: {
      flags: {
        key: { kind: 'parsed', parse: stringParser, brief: 'Workspace-scoped browser key (default "default").', optional: true, placeholder: 'name' },
        session: { kind: 'parsed', parse: stringParser, brief: 'Raw agent-browser session name (mutually exclusive with --key/--surface).', optional: true, placeholder: 'name' },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface handle whose bound session to drive (mutually exclusive with --key/--session).', optional: true, placeholder: 'handle' },
        workspace: workspaceFlag,
      },
      positional: {
        kind: 'array',
        parameter: { parse: stringParser, brief: 'Arguments forwarded verbatim to agent-browser.', placeholder: 'args' },
        minimum: 0,
      },
    },
    func: async function (this: DorCommandContext, _flags: { key?: string; session?: string; surface?: string; workspace?: string }, ..._args: string[]): Promise<void | Error> {
      // runCli intercepts every non-help agent-browser invocation before
      // stricli; reaching this func means that interception regressed.
      return new Error('internal: agent-browser passthrough was not intercepted');
    },
  }),
};

// `goto` / `navigate` are documented aliases of `open`, so a Dormouse target
// resolves the same in all three.
const AGENT_BROWSER: BrowserCliDescriptor = {
  provider: 'agent-browser',
  sessionNoun: 'an agent-browser session name',
  navigationVerbs: new Set(['open', 'goto', 'navigate']),
  // `close` tears the session down; the Wall notices the stream dropping and
  // placeholders the surface, so opening one here would be self-defeating.
  noBind: new Set(['close']),
  informational: new Set(['--help', '-h']),
  // Its sessions are global to the socket directory: a command runs where the
  // caller is, with the caller's executable.
  projectScoped: false,
  missingBinaryMessage,
  exec: (options) => options.execAgentBrowser,
  // Under the caller's own socket directory and CLI, whatever state files
  // that CLI writes (docs/specs/dor-browser.md → "agent-browser").
  streamStatus: streamStatusArgs,
};

export function runAgentBrowserCli(args: string[], options: CliOptions): Promise<CliResult> {
  return runBrowserCli(AGENT_BROWSER, args, options);
}
