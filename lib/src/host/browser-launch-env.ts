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
}

/** Run the staged dor with the same startup files as a fresh interactive login
 * shell. No PTY or Surface is created. Startup output must never be included in
 * errors: profiles can print secrets, as can the helper's environment payload. */
export async function browserLaunchEnv(cwd: string | undefined, runtime: BrowserShellRuntime, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (!runtime.node || !runtime.cli) throw new Error('Browser launch helper is not configured');
  const shell = runtime.shell || (process.platform === 'win32'
    ? env.ComSpec || env.COMSPEC || path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe')
    : env.SHELL || userInfo().shell || '/bin/sh');
  const kind = shellCommandKind(shell, process.platform);
  const marker = randomBytes(16).toString('hex');
  const argv = [runtime.node, runtime.cli, '__launch-env', marker];
  let args: string[];
  if (kind === 'cmd') {
    // Runtime paths are supplied by the host, never the webview. Refuse cmd's
    // expansion characters rather than allowing a path to become shell code.
    if (argv.some(s => /[%!"\r\n]/.test(s))) throw new Error('Browser launch runtime path cannot be quoted for cmd.exe');
    args = ['/s', '/c', '"' + argv.map(s => '"' + s + '"').join(' ') + '"'];
  } else if (kind === 'powershell') {
    args = ['-NonInteractive', '-Command', buildShellCommandForKind(kind, argv)];
  } else {
    // csh and tcsh refuse -l alongside other flags.
    args = [/(^|[\\/])t?csh$/i.test(shell) ? '-ic' : '-ilc', buildShellCommandForKind(kind, argv)];
  }
  // A removed project directory must not strand a restored session's close.
  const result = await spawnAndCapture(shell, args, {
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
