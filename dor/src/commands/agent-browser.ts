/** `dor ab` passthrough and Surface binding; see docs/specs/dor-cli.md and
 * docs/specs/dor-browser.md. `runCli` intercepts real invocations before
 * stricli so forwarded arguments are never parsed as dor flags. */

import { buildCommand } from '@stricli/core';
// All external spawns go through dor-lib-common's spawnAndCapture, which owns the
// Windows recipe (cross-spawn for PATHEXT/.cmd, windowsHide, exit-vs-close).
// See docs/specs/dor-cli.md → "Spawning External Binaries".
import {
  parseStreamPort,
  sessionForKey,
  streamStatusArgs,
  AGENT_BROWSER_BIN_ENV,
  DEFAULT_AGENT_BROWSER_BIN,
} from 'dor-lib-common';
import {
  browserBinaryIsMissing,
  execBrowserProcess,
  extractSessionFlags,
  isMissingBinaryError,
  resolveBinaryPath,
  resolveOpenTargetArgs,
  type ResolvedSessionFlags,
} from './browser-cli.js';
import type {
  AgentBrowserExecResult,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  ParseResult,
} from './types.js';
import { errorMessage, fail, requireControlClient, stringParser, workspaceFlag, workspaceParam } from './shared.js';

const INSTALL_HINT = 'npm i -g agent-browser';
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
    'dor ab drives your own agent-browser binary, which Dormouse never bundles.',
    'Install it, then re-run your command:',
    '',
    `    ${INSTALL_HINT}`,
    '',
    `More: ${INSTALL_DOCS}`,
    `Already installed? Make sure it's on your PATH, or set ${AGENT_BROWSER_BIN_ENV} to its full path.`,
  ].join('\n');
}

export const agentBrowserCommand: Command = {
  name: 'agent-browser',
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
      brief: 'Drive a browser surface via your agent-browser install (alias: dor ab).',
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

After a successful command, dor opens (or reuses) the browser surface bound to
the session: one session is always exactly one surface.

In an "open" command, dor also resolves a Dormouse target in place of a URL:
a schemeless host:port (and the ":<port>" localhost shorthand) defaults to
http:// rather than agent-browser's https://, and a terminal Surface handle
(surface:N, surface:self, surface:focused, or a stable id) resolves to the
dev-server URL that terminal owns via the host port scan.

Examples:
  dor ab open http://localhost:5173        # key "default"
  dor ab open localhost:5173                # → http://localhost:5173/
  dor ab open :5173                         # → http://localhost:5173/
  dor ab open surface:3                     # open the port terminal surface:3 owns
  dor ab --key storybook open http://localhost:6006
  dor ab click @e3                          # drives key "default"
  dor ab --key storybook reload             # drives key "storybook"
  dor ab --surface surface:4 click @e3      # drives whatever surface:4 is bound to`,
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

export async function runAgentBrowserCli(args: string[], options: CliOptions): Promise<CliResult> {
  const flags = extractSessionFlags(args);
  if (!flags.ok) return fail(flags.message);
  const { key } = flags.value;

  // `--surface <handle>` names the browser Surface rather than the session, so
  // the session comes from the host's session↔surface registry before anything
  // is forwarded. This is the only way to drive a GUI-spawned session, whose
  // `gui-<hex>` name no `--key` can produce.
  const resolvedSession = await resolveSession(flags.value, options);
  if (!resolvedSession.ok) return fail(resolvedSession.message);
  const session = resolvedSession.value;

  // `dor ab open <target>` accepts a Surface handle / bare :port wherever it
  // takes a URL; resolve it to a URL before forwarding, because agent-browser
  // only understands URLs. Every other command's args pass through untouched.
  const resolvedRest = await resolveOpenTargetArgs(flags.value.rest, options, flags.value.workspace);
  if (!resolvedRest.ok) return fail(resolvedRest.message);
  const rest = resolvedRest.value;

  const env = options.env ?? {};
  const binary = env[AGENT_BROWSER_BIN_ENV] || DEFAULT_AGENT_BROWSER_BIN;
  const exec = options.execAgentBrowser ?? execBrowserProcess;

  // Resolve the binary to an absolute path once: it proves the install present
  // (below), is what we spawn (see `execTarget`), and travels to the host as
  // `binaryPath` (a GUI host may not share this terminal's PATH). undefined
  // means "not found on PATH" — or, for an explicit path, simply "returned
  // verbatim", which browserBinaryIsMissing re-checks on disk.
  const binaryPath = resolveBinaryPath(binary, env);

  // Spawn the resolved path, never the bare name: cross-spawn resolves a bare
  // name through `which`, which checks `process.cwd()` *before* PATH on Windows
  // (and re-emits the bare name into cmd.exe for a `.cmd` shim, which does the
  // same). Since `dor` inherits the pane's cwd, a bare-name spawn would let an
  // `agent-browser.cmd` sitting in a cloned repository win the race against the
  // real install — repo content executing with no gate, which
  // docs/specs/dor-tool.md -> Trust treats as a boundary.
  //
  // The `?? binary` branch is unreachable on the real path and is a type-level
  // belt only: browserBinaryIsMissing already ends the call whenever binaryPath is
  // undefined, and an explicit path comes back from resolveBinaryPath verbatim.
  // Only a stub exec (tests), which skips that check, reaches it.
  // See docs/specs/dor-cli.md -> "Spawning External Binaries".
  const execTarget = binaryPath ?? binary;

  // Detect a missing install deterministically, before spawning. A failed spawn
  // on Windows emits BOTH 'error' (ENOENT) and 'close' (a libuv error code); if
  // 'close' wins that race the process resolves with a bogus exit code and no
  // output, so `dor ab` would print nothing at all. Checking the filesystem
  // ourselves sidesteps that ordering. Skipped when a stub exec is injected
  // (tests), which supplies its own ENOENT behavior via the catch below.
  if (options.execAgentBrowser === undefined && browserBinaryIsMissing(binary, env, binaryPath)) {
    return fail(missingBinaryMessage(binary));
  }

  let result: AgentBrowserExecResult;
  try {
    result = await exec(execTarget, ['--session', session, ...rest]);
  } catch (error) {
    if (isMissingBinaryError(error)) {
      return fail(missingBinaryMessage(binary));
    }
    return fail(errorMessage(error));
  }

  let stderrSuffix = '';
  if (shouldManageSurface(result.exitCode, rest)) {
    const client = requireControlClient(options);
    // Outside a Dormouse terminal there is no control endpoint; stay a pure
    // passthrough rather than nagging about the missing surface.
    if (!(client instanceof Error)) {
      try {
        const status = await exec(execTarget, streamStatusArgs(session));
        const wsPort = parseStreamPort(status.stdout);
        // Pass the absolute path resolved above so the host (which may not share
        // this terminal's PATH) can run host-side tab/close commands.
        await client.agentBrowserSurface({
          key,
          session,
          wsPort,
          ...(binaryPath ? { binaryPath } : {}),
          ...workspaceParam(flags.value.workspace),
        });
      } catch (error) {
        stderrSuffix = `Warning: could not open the Dormouse browser surface: ${errorMessage(error)}\n`;
      }
    }
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr + stderrSuffix,
  };
}

/**
 * The agent-browser session to forward — one `surface.resolveAgentBrowser` round
 * trip for the two forms only the host can name:
 *
 * - `--session <name>` is already the session; nothing is asked.
 * - `--key <name>` is namespaced under the Workspace that will hold the browser,
 *   which only that Workspace knows (`docs/specs/dor-browser.md` → "Managed identity").
 *   **Outside Dormouse the CLI namespaces it itself**, so `dor ab` stays a
 *   passthrough with no control endpoint.
 * - `--surface <handle>` is the session the host says that Surface is bound to.
 *   The host owns the gating: the target must have a browser, and that browser
 *   must be agent-browser-rendered with a session (an `iframe` renderer has no
 *   session to drive).
 *
 * The host's messages are printed verbatim; dor does not re-interpret them.
 * **A host that refuses fails the command** before the binary runs — there is
 * no fallback to a CLI-namespaced key, which would name the wrong Workspace's
 * browser (`docs/specs/dor-browser.md` → "Managed identity").
 */
async function resolveSession(
  flags: ResolvedSessionFlags,
  options: CliOptions,
): Promise<ParseResult<string>> {
  if (flags.session !== undefined) return { ok: true, value: flags.session };
  const client = requireControlClient(options);
  if (client instanceof Error) {
    return flags.key === undefined
      ? { ok: false, message: client.message }
      : { ok: true, value: sessionForKey(flags.key) };
  }
  try {
    const { session } = await client.resolveAgentBrowserSession({
      ...(flags.key === undefined ? { surface: flags.surface } : { key: flags.key }),
      ...workspaceParam(flags.workspace),
    });
    return { ok: true, value: session };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function shouldManageSurface(exitCode: number, rest: string[]): boolean {
  if (exitCode !== 0 || rest.length === 0) return false;
  if (rest.includes('--help') || rest.includes('-h')) return false;
  // `close` tears the session down; the Wall notices the stream dropping and
  // placeholders the surface, so opening one here would be self-defeating.
  const subcommand = rest.find((arg) => !arg.startsWith('-'));
  return subcommand !== undefined && subcommand !== 'close';
}
