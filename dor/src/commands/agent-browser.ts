/**
 * `dor agent-browser` (alias `dor ab`) — near-transparent passthrough to the
 * user's own agent-browser binary, plus Dormouse surface management.
 *
 * Dormouse intercepts exactly two flags: `--key` (managed, workspace-scoped,
 * default "default") and `--session` (raw escape hatch). Everything else is
 * forwarded verbatim to `agent-browser --session <resolved> <args...>`. After
 * a successful forwarded command, the stream WebSocket port is read via
 * `stream status --json` and a `surface.agentBrowser` control request asks the
 * Wall to create or reuse the browser surface bound to that session.
 *
 * The stricli command registered here exists only to serve `--help`; real
 * invocations are intercepted in `runCli` before stricli parses argv, because
 * forwarded agent-browser args (e.g. `open --headed`) must not be parsed as
 * dor flags.
 */

import { buildCommand } from '@stricli/core';
import { spawn } from 'node:child_process';
import type {
  AgentBrowserExecResult,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  ParseResult,
} from './types.js';
import { fail, resolveControlClient, stringParser } from './shared.js';

/** Hardcoded until Dormouse exposes real workspaces; encoded now to avoid a rename. */
const WORKSPACE_ID = '1';

const INSTALL_HINT = 'npm i -g agent-browser';

// agent-browser session names become filesystem paths (socket dir), so `/` is
// not usable as a namespace separator — the daemon fails to start. Dots keep
// the managed namespace readable: dormouse.<workspaceId>.<key>.
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function sessionForKey(key: string): string {
  return `dormouse.${WORKSPACE_ID}.${key}`;
}

export const agentBrowserCommand: Command = {
  name: 'agent-browser',
  helpPatches: [
    {
      scope: 'root',
      findReplace: ['agent-browser [--key name] [--session name]<TO-EOL>', 'agent-browser [--key name|--session name] [args...]\n'],
    },
    {
      scope: 'command-usage',
      findReplace: ['agent-browser [--key name] [--session name]<TO-EOL>', 'agent-browser [--key name|--session name] [args...]\n'],
    },
  ],
  command: buildCommand<{ key?: string; session?: string }, [...args: string[]], DorCommandContext>({
    docs: {
      brief: 'Drive a browser surface via your agent-browser install (alias: dor ab).',
      fullDescription: `Forwards all arguments verbatim to your own agent-browser binary and binds the session to a Dormouse browser surface.

dor intercepts exactly two flags:
  --key <name>      Managed, workspace-scoped browser identity (default "default").
                    Maps to agent-browser session dormouse.1.<name>.
  --session <name>  Attach to a raw agent-browser session by its literal name.
                    Mutually exclusive with --key.

Everything else — subcommands, flags, selectors — is agent-browser's own
command surface. The binary is resolved from PATH (override with
DORMOUSE_AGENT_BROWSER_BIN) and is never bundled; install it with:
  ${INSTALL_HINT}

After a successful command, dor opens (or reuses) the browser surface bound to
the session: one session is always exactly one surface.

Examples:
  dor ab open http://localhost:5173        # key "default"
  dor ab --key storybook open http://localhost:6006
  dor ab click @e3                          # drives key "default"
  dor ab --key storybook reload             # drives key "storybook"`,
    },
    parameters: {
      flags: {
        key: { kind: 'parsed', parse: stringParser, brief: 'Workspace-scoped browser key (default "default").', optional: true, placeholder: 'name' },
        session: { kind: 'parsed', parse: stringParser, brief: 'Raw agent-browser session name (mutually exclusive with --key).', optional: true, placeholder: 'name' },
      },
      positional: {
        kind: 'array',
        parameter: { parse: stringParser, brief: 'Arguments forwarded verbatim to agent-browser.', placeholder: 'args' },
        minimum: 0,
      },
    },
    func: async function (this: DorCommandContext, _flags: { key?: string; session?: string }, ..._args: string[]): Promise<void | Error> {
      // runCli intercepts every non-help agent-browser invocation before
      // stricli; reaching this func means that interception regressed.
      return new Error('internal: agent-browser passthrough was not intercepted');
    },
  }),
};

interface ResolvedSessionFlags {
  /** Managed key; undefined when the caller attached via raw --session. */
  key?: string;
  session: string;
  rest: string[];
}

export function extractSessionFlags(args: string[]): ParseResult<ResolvedSessionFlags> {
  let key: string | undefined;
  let session: string | undefined;
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const flag = arg === '--key' || arg.startsWith('--key=')
      ? '--key'
      : arg === '--session' || arg.startsWith('--session=')
        ? '--session'
        : null;
    if (!flag) {
      rest.push(arg);
      continue;
    }

    let value: string | undefined;
    if (arg.includes('=')) {
      value = arg.slice(arg.indexOf('=') + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (!value || value.startsWith('-')) {
      return { ok: false, message: `${flag} requires a value` };
    }
    if (flag === '--key') key = value;
    else session = value;
  }

  if (key !== undefined && session !== undefined) {
    return { ok: false, message: '--key and --session are mutually exclusive' };
  }
  if (key !== undefined && !KEY_PATTERN.test(key)) {
    return { ok: false, message: `--key must match ${KEY_PATTERN} (it becomes part of an agent-browser session name)` };
  }

  if (session !== undefined) {
    return { ok: true, value: { session, rest } };
  }
  const resolvedKey = key ?? 'default';
  return { ok: true, value: { key: resolvedKey, session: sessionForKey(resolvedKey), rest } };
}

export async function runAgentBrowserCli(args: string[], options: CliOptions): Promise<CliResult> {
  const flags = extractSessionFlags(args);
  if (!flags.ok) return fail(flags.message);
  const { key, session, rest } = flags.value;

  const env = options.env ?? {};
  const binary = env.DORMOUSE_AGENT_BROWSER_BIN || 'agent-browser';
  const exec = options.execAgentBrowser ?? execAgentBrowserProcess;

  let result: AgentBrowserExecResult;
  try {
    result = await exec(binary, ['--session', session, ...rest]);
  } catch (error) {
    if (isMissingBinaryError(error)) {
      return fail(`agent-browser was not found (looked for '${binary}'). Install it with: ${INSTALL_HINT}`);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }

  let stderrSuffix = '';
  if (shouldManageSurface(result.exitCode, rest)) {
    const clientResult = resolveControlClient(options);
    // Outside a Dormouse terminal there is no control endpoint; stay a pure
    // passthrough rather than nagging about the missing surface.
    if (clientResult.ok) {
      try {
        const status = await exec(binary, ['--session', session, 'stream', 'status', '--json']);
        const wsPort = parseStreamPort(status.stdout);
        await clientResult.value.agentBrowserSurface({ key, session, wsPort });
      } catch (error) {
        stderrSuffix = `Warning: could not open the Dormouse browser surface: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr + stderrSuffix,
  };
}

function shouldManageSurface(exitCode: number, rest: string[]): boolean {
  if (exitCode !== 0 || rest.length === 0) return false;
  if (rest.includes('--help') || rest.includes('-h')) return false;
  // `close` tears the session down; the Wall notices the stream dropping and
  // placeholders the surface, so opening one here would be self-defeating.
  const subcommand = rest.find((arg) => !arg.startsWith('-'));
  return subcommand !== undefined && subcommand !== 'close';
}

function parseStreamPort(stdout: string): number | undefined {
  try {
    const parsed = JSON.parse(stdout) as { port?: unknown; data?: { port?: unknown } };
    const port = parsed.data?.port ?? parsed.port;
    return typeof port === 'number' && Number.isFinite(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function isMissingBinaryError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

// agent-browser talks to a daemon, so forwarded commands return quickly;
// buffering output until exit keeps this transport-agnostic with runCli's
// captured stdout/stderr at the cost of not streaming long-running output.
function execAgentBrowserProcess(binary: string, args: string[]): Promise<AgentBrowserExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
