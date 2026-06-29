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
// cross-spawn, not node:child_process — on Windows a bare command name never
// resolves a `.cmd`/`.bat` PATH shim (Node spawn ignores PATHEXT → ENOENT), and
// Node >=22 refuses to spawn a `.cmd` directly even by full path (EINVAL, the
// CVE-2024-27980 hardening). agent-browser ships as a `.cmd` shim, so both bite.
// cross-spawn routes through cmd.exe with correct escaping and is a no-op
// passthrough on POSIX. See docs/specs/dor-cli.md → "Spawning External Binaries".
import spawn from 'cross-spawn';
import { existsSync } from 'node:fs';
import type {
  CliEnv,
  AgentBrowserExecResult,
  CliOptions,
  CliResult,
  Command,
  DorCommandContext,
  ParseResult,
} from './types.js';
import { fail, requireControlClient, stringParser } from './shared.js';

/** Hardcoded until Dormouse exposes real workspaces; encoded now to avoid a rename. */
const WORKSPACE_ID = '1';

const INSTALL_HINT = 'npm i -g agent-browser';
const INSTALL_DOCS = 'https://agent-browser.dev';
const BIN_ENV = 'DORMOUSE_AGENT_BROWSER_BIN';

// Extensions a bare command name can carry on Windows, in PATH-search order.
// Shared by resolveBinaryPath (PATH walk) and existsCandidate (explicit path).
const WINDOWS_BIN_EXTS = ['.cmd', '.exe', '.bat'];

/**
 * Clear, multi-line guidance shown when the user's agent-browser binary is
 * absent. `binary` is named only when it differs from the default, so a custom
 * DORMOUSE_AGENT_BROWSER_BIN that points nowhere still tells the user what was
 * looked for.
 */
function missingBinaryMessage(binary: string): string {
  const lookedFor = binary === 'agent-browser' ? '' : ` (looked for '${binary}')`;
  return [
    `agent-browser is not installed${lookedFor}.`,
    '',
    'dor ab drives your own agent-browser binary, which Dormouse never bundles.',
    'Install it, then re-run your command:',
    '',
    `    ${INSTALL_HINT}`,
    '',
    `More: ${INSTALL_DOCS}`,
    `Already installed? Make sure it's on your PATH, or set ${BIN_ENV} to its full path.`,
  ].join('\n');
}

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

  // Resolve the binary to an absolute path once: it both proves the install
  // present (below) and travels to the host as `binaryPath` (a GUI host may not
  // share this terminal's PATH). undefined means "not found on PATH" — or, for
  // an explicit path, simply "returned verbatim", which agentBrowserIsMissing
  // re-checks on disk.
  const binaryPath = resolveBinaryPath(binary, env);

  // Detect a missing install deterministically, before spawning. A failed spawn
  // on Windows emits BOTH 'error' (ENOENT) and 'close' (a libuv error code); if
  // 'close' wins that race the process resolves with a bogus exit code and no
  // output, so `dor ab` would print nothing at all. Checking the filesystem
  // ourselves sidesteps that ordering. Skipped when a stub exec is injected
  // (tests), which supplies its own ENOENT behavior via the catch below.
  if (options.execAgentBrowser === undefined && agentBrowserIsMissing(binary, env, binaryPath)) {
    return fail(missingBinaryMessage(binary));
  }

  let result: AgentBrowserExecResult;
  try {
    result = await exec(binary, ['--session', session, ...rest]);
  } catch (error) {
    if (isMissingBinaryError(error)) {
      return fail(missingBinaryMessage(binary));
    }
    return fail(error instanceof Error ? error.message : String(error));
  }

  let stderrSuffix = '';
  if (shouldManageSurface(result.exitCode, rest)) {
    const client = requireControlClient(options);
    // Outside a Dormouse terminal there is no control endpoint; stay a pure
    // passthrough rather than nagging about the missing surface.
    if (!(client instanceof Error)) {
      try {
        const status = await exec(binary, ['--session', session, 'stream', 'status', '--json']);
        const wsPort = parseStreamPort(status.stdout);
        // Pass the absolute path resolved above so the host (which may not share
        // this terminal's PATH) can run host-side tab/close commands.
        await client.agentBrowserSurface({
          key,
          session,
          wsPort,
          ...(binaryPath ? { binaryPath } : {}),
        });
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

export function resolveBinaryPath(binary: string, env: CliEnv): string | undefined {
  if (binary.includes('/') || binary.includes('\\')) return binary;
  const pathVar = env.PATH;
  if (!pathVar) return undefined;
  const isWindows = process.platform === 'win32';
  const names = isWindows ? WINDOWS_BIN_EXTS.map((ext) => `${binary}${ext}`) : [binary];
  for (const dir of pathVar.split(isWindows ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir}${isWindows ? '\\' : '/'}${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
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

/**
 * Whether the binary can be proven absent without spawning it, given the path
 * `resolveBinaryPath` already produced for it. Returns true only when the absence
 * is certain; ambiguous cases (no PATH to search) fall through to the spawn,
 * which still rejects with ENOENT.
 */
function agentBrowserIsMissing(binary: string, env: CliEnv, resolvedPath: string | undefined): boolean {
  // Explicit path (e.g. a DORMOUSE_AGENT_BROWSER_BIN override): resolveBinaryPath
  // hands such a path back verbatim without touching disk, so check it (and
  // Windows launcher extensions) directly.
  if (binary.includes('/') || binary.includes('\\')) {
    return !existsCandidate(binary, process.platform === 'win32');
  }
  // Bare name: resolvedPath is the PATH walk's result. Without a PATH to search
  // we can't prove anything, so let the spawn decide.
  if (!env.PATH) return false;
  return resolvedPath === undefined;
}

function existsCandidate(path: string, isWindows: boolean): boolean {
  if (existsSync(path)) return true;
  if (!isWindows) return false;
  return WINDOWS_BIN_EXTS.some((ext) => existsSync(`${path}${ext}`));
}

// agent-browser talks to a daemon, so forwarded commands return quickly;
// buffering output until exit keeps this transport-agnostic with runCli's
// captured stdout/stderr at the cost of not streaming long-running output.
//
// Grace window for 'close' to win after 'exit' before we resolve anyway. See
// execAgentBrowserProcess: long enough that a normal command's stdio drains
// (its output was written before the process exited), short enough that the
// daemon-holds-the-pipe case doesn't feel like a hang.
const CLOSE_GRACE_MS = 250;

function execAgentBrowserProcess(binary: string, args: string[]): Promise<AgentBrowserExecResult> {
  return new Promise((resolve, reject) => {
    // windowsHide: cross-spawn runs `.cmd` shims through cmd.exe; without this
    // each spawn flashes a console window that steals focus. No-op off Windows.
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    // A failed spawn races 'error' against the exit events; latch on the first so
    // the loser can't overwrite the outcome (e.g. a stray exit code swallowing an
    // ENOENT). clearTimeout drops the grace timer so it can't keep the event loop
    // alive after we've already settled.
    let settled = false;
    let graceTimer: number | undefined;
    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      apply();
    };
    child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
    child.on('error', (error: Error) => settle(() => reject(error)));
    const finish = (code: number | null): void => settle(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
    // 'close' is the clean path: the process exited AND its stdio reached EOF, so
    // all output is captured. But `agent-browser open` leaves a detached daemon
    // that on Windows inherits our stdout/stderr pipes — they never reach EOF and
    // 'close' never fires, so waiting on it alone hangs forever. Fall back to
    // 'exit' (which fires when the foreground process ends regardless of the
    // lingering pipe), giving 'close' a short grace to win first so a normal
    // command's full output is still flushed before we resolve.
    child.on('close', (code: number | null) => finish(code));
    child.on('exit', (code: number | null) => {
      graceTimer = setTimeout(() => finish(code), CLOSE_GRACE_MS);
    });
  });
}
