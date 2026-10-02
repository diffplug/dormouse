/** Host-only fresh-shell environment; never crosses the webview boundary. */
import path from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isDirectory, spawnAndCapture } from 'dor-lib-common';
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';

export interface BrowserShellRuntime {
  node: string;
  cli: string;
  shell?: string;
  args?: readonly string[];
}

/** The helper is a native host process. A WSL terminal selection cannot supply
 * a usable native PATH or Playwright library; use the native default instead. */
export function browserShellInvocation(runtime: BrowserShellRuntime, argv: string[], env: NodeJS.ProcessEnv, platform = process.platform): { shell: string; args: string[] } {
  const wsl = platform === 'win32' && /(^|[\\/])wsl(?:\.exe)?$/i.test(runtime.shell ?? '');
  const shell = (!wsl && runtime.shell) || (platform === 'win32'
    ? env.ComSpec || env.COMSPEC || path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe')
    : env.SHELL || userInfo().shell || '/bin/sh');
  const selected = wsl ? [] : [...(runtime.args ?? [])];
  const kind = shellCommandKind(shell, platform);
  let args: string[];
  if (kind === 'cmd') {
    // cmd expands these bytes even inside quotes. Runtime and startup paths
    // are host-owned; refusing unusual paths is safer than changing their text.
    if (argv.some(s => /[%!"\r\n]/.test(s))) throw new Error('Browser launch runtime path cannot be quoted for cmd.exe');
    const helper = argv.map(s => '"' + s + '"').join(' ');
    const commandAt = selected.findIndex(s => /^\/[kc]$/i.test(s));
    let command = helper;
    if (commandAt >= 0) {
      const startup = selected.splice(commandAt).slice(1);
      // The Developer Command Prompt picker supplies a batch path after /k.
      if (startup.length === 1 && /\.(bat|cmd)$/i.test(startup[0])) {
        if (/[%!"\r\n]/.test(startup[0])) throw new Error('Browser launch startup path cannot be quoted for cmd.exe');
        command = `call "${startup[0]}" && ${helper}`;
      } else if (startup.length) command = `${startup.join(' ')} && ${helper}`;
    }
    args = [...selected, '/s', '/c', '"' + command + '"'];
  } else if (kind === 'powershell') {
    const startupArgs = selected.filter(s => !/^-NoExit$/i.test(s));
    const commandAt = startupArgs.findIndex(s => /^-(Command|c)$/i.test(s));
    const startup = commandAt < 0 ? '' : startupArgs.splice(commandAt).slice(1).join(' ');
    const helper = buildShellCommandForKind(kind, argv);
    args = [...startupArgs, '-NonInteractive', '-Command', startup ? `${startup}; if ($?) { ${helper} }` : helper];
  } else {
    // Preserve picker/profile flags (including Git Bash's --login -i).
    const startupArgs = selected.length ? selected : [/(^|[\\/])t?csh$/i.test(shell) ? '-i' : '-il'];
    const commandAt = startupArgs.findIndex(s => s === '-c' || s === '--command');
    const helper = buildShellCommandForKind(kind, argv);
    if (commandAt >= 0) {
      startupArgs[commandAt + 1] = `${startupArgs[commandAt + 1] ?? ''}; ${helper}`;
      args = startupArgs;
    } else args = [...startupArgs, '-c', helper];
  }
  return { shell, args };
}

/** Startup output stays on a host-owned pipe and never enters diagnostics. */
export async function browserLaunchEnv(cwd: string | undefined, runtime: BrowserShellRuntime, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (!runtime.node || !runtime.cli) throw new Error('Browser launch helper is not configured');
  const marker = randomBytes(16).toString('hex');
  const { shell, args } = browserShellInvocation(runtime, [runtime.node, runtime.cli, '__launch-env', marker], env);
  // A removed project directory must not strand a restored session's close.
  // Bounded in time and output well inside a launch's startup deadline
  // (`REQUEST_BUDGET_MS` in ./browser-host.ts).
  const result = await spawnAndCapture(shell, args, {
    // Unlike a .cmd shim, explicit cmd.exe bypasses cross-spawn's shell wrapper.
    windowsVerbatimArguments: shellCommandKind(shell, process.platform) === 'cmd',
    cwd: cwd !== undefined && isDirectory(cwd) ? cwd : undefined, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024,
  });
  if (!result.ok || result.exitCode !== 0) throw new Error(`Browser launch shell failed (${shell}); check its startup configuration${!result.ok && result.error.code ? ` [${result.error.code}]` : ''}`);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith(marker + ':'));
  try {
    const value: unknown = JSON.parse(Buffer.from(line?.slice(marker.length + 1) ?? '', 'base64').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
    return value as NodeJS.ProcessEnv;
  } catch {
    throw new Error(`Browser launch shell did not return its environment (${shell}); check its startup configuration`);
  }
}
