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
// All external spawns go through dor-lib-common's spawnAndCapture, which owns the
// Windows recipe (cross-spawn for PATHEXT/.cmd, windowsHide, exit-vs-close).
// See docs/specs/dor-cli.md → "Spawning External Binaries".
import {
  spawnAndCapture,
  parseStreamPort,
  sessionForKey,
  streamStatusArgs,
  AGENT_BROWSER_BIN_ENV,
  DEFAULT_AGENT_BROWSER_BIN,
} from 'dor-lib-common';
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
import { errorMessage, fail, requireControlClient, stringParser } from './shared.js';
import {
  inferredHttpUrl,
  isSpecialOpenTarget,
  isSurfaceOpenTarget,
  resolveSurfaceOpenTarget,
} from './open-target.js';

const INSTALL_HINT = 'npm i -g agent-browser';
const INSTALL_DOCS = 'https://agent-browser.dev';

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

// A managed --key becomes part of an agent-browser session name (see
// sessionForKey in dor-lib-common), which becomes a filesystem path — so `/` is
// not usable; restrict to a readable, path-safe charset.
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

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
  const { key, session } = flags.value;

  // `dor ab open <target>` accepts a Surface handle / bare :port wherever it
  // takes a URL; resolve it to a URL before forwarding, because agent-browser
  // only understands URLs. Every other command's args pass through untouched.
  const resolvedRest = await resolveOpenTargetArgs(flags.value.rest, options);
  if (!resolvedRest.ok) return fail(resolvedRest.message);
  const rest = resolvedRest.value;

  const env = options.env ?? {};
  const binary = env[AGENT_BROWSER_BIN_ENV] || DEFAULT_AGENT_BROWSER_BIN;
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
    return fail(errorMessage(error));
  }

  let stderrSuffix = '';
  if (shouldManageSurface(result.exitCode, rest)) {
    const client = requireControlClient(options);
    // Outside a Dormouse terminal there is no control endpoint; stay a pure
    // passthrough rather than nagging about the missing surface.
    if (!(client instanceof Error)) {
      try {
        const status = await exec(binary, streamStatusArgs(session));
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

// agent-browser's URL-navigation verbs. `goto` / `navigate` are documented
// aliases of `open`, so a Dormouse target resolves the same in all three.
const OPEN_SUBCOMMANDS = new Set(['open', 'goto', 'navigate']);

/**
 * Rewrite a forwarded navigation argv so agent-browser receives a URL:
 * `surface:` handles resolve via the host port scan, a bare `:port`/`host:port`
 * sugars to http. Non-navigation commands and plain URLs pass through unchanged.
 *
 * The target is matched by shape (not position), which is what lets `open
 * --headed surface:3` resolve — dor can't know agent-browser's flag arity, so it
 * can't reliably find "the positional". The trade-off is that a *flag value*
 * shaped like a target would be grabbed; this is safe because no agent-browser
 * `open` flag takes a `surface:`/`:port`/`host:port`-shaped value (`--headers` is
 * JSON, `--init-script` a path, `--enable` a feature name), and `inferredHttpUrl`
 * rejects a bare-integer host so a stray `n:n` value can't become a URL. Only the
 * first special-shaped arg is rewritten — these verbs take a single target.
 */
async function resolveOpenTargetArgs(rest: string[], options: CliOptions): Promise<ParseResult<string[]>> {
  const subcommand = rest.find((arg) => !arg.startsWith('-'));
  if (subcommand === undefined || !OPEN_SUBCOMMANDS.has(subcommand)) return { ok: true, value: rest };

  const index = rest.findIndex((arg) => isSpecialOpenTarget(arg));
  if (index === -1) return { ok: true, value: rest };

  const raw = rest[index] ?? '';
  let url: string;
  if (isSurfaceOpenTarget(raw)) {
    // A Surface handle only resolves against a live Dormouse host; outside one
    // there is no control endpoint and the error says so.
    const client = requireControlClient(options);
    if (client instanceof Error) return { ok: false, message: client.message };
    const resolved = await resolveSurfaceOpenTarget(raw, client);
    if (!resolved.ok) return resolved;
    url = resolved.value;
  } else {
    // A schemeless :port / host:port needs no host round trip. isSpecialOpenTarget
    // matched a non-surface target, so inference here always succeeds; leave argv
    // untouched rather than forward a non-URL if that ever changes.
    const inferred = inferredHttpUrl(raw);
    if (inferred === null) return { ok: true, value: rest };
    url = inferred;
  }

  const next = [...rest];
  next[index] = url;
  return { ok: true, value: next };
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

// The default exec: delegate the spawn/capture/Windows handling to
// spawnAndCapture, and adapt its never-throws result to this call site's
// throw-on-spawn-failure contract (callers catch ENOENT via isMissingBinaryError).
async function execAgentBrowserProcess(binary: string, args: string[]): Promise<AgentBrowserExecResult> {
  const result = await spawnAndCapture(binary, args);
  if (!result.ok) {
    const error: Error & { code?: string } = new Error(result.error.message);
    error.code = result.error.code;
    throw error;
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
