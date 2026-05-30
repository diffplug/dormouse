import { execFileSync } from 'node:child_process';

export type ShellCommandKind = 'cmd' | 'posix' | 'powershell';

const POSIX_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;

export function buildShellCommand(args: readonly string[], env: Readonly<Partial<Record<string, string>>> = {}): string | undefined {
  if (args.join('').trim() === '') return undefined;
  return buildShellCommandForKind(detectCallerShellKind(env), args);
}

export function buildShellCommandForKind(kind: ShellCommandKind, args: readonly string[]): string {
  switch (kind) {
    case 'cmd':
      return args.map(quoteCmdArg).join(' ');
    case 'powershell':
      return quotePowerShellCommand(args);
    case 'posix':
      return args.map(quotePosixArg).join(' ');
  }
}

export function detectCallerShellKind(env: Readonly<Partial<Record<string, string>>> = {}): ShellCommandKind {
  return shellCommandKind(
    parentProcessName() ||
      env.SHELL ||
      env.ComSpec ||
      env.COMSPEC,
    process.platform,
  );
}

export function shellCommandKind(shell: string | undefined, platformString: string): ShellCommandKind {
  const normalizedShell = (shell ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!normalizedShell && /win/i.test(platformString)) return 'cmd';
  if (normalizedShell === 'cmd.exe' || normalizedShell === 'cmd') return 'cmd';
  if (normalizedShell === 'powershell.exe' || normalizedShell === 'powershell' || normalizedShell === 'pwsh.exe' || normalizedShell === 'pwsh') {
    return 'powershell';
  }
  return 'posix';
}

function parentProcessName(): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const output = execFileSync('ps', ['-p', String(process.ppid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function quotePosixArg(arg: string): string {
  if (arg === '') return "''";
  if (POSIX_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellCommand(args: readonly string[]): string {
  const [command, ...rest] = args;
  if (command === undefined) return '';
  const quotedCommand = quotePowerShellArg(command);
  const commandPrefix = quotedCommand.startsWith("'") ? '& ' : '';
  return `${commandPrefix}${[quotedCommand, ...rest.map(quotePowerShellArg)].join(' ')}`;
}

function quotePowerShellArg(arg: string): string {
  if (arg === '') return "''";
  if (WINDOWS_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "''")}'`;
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  const escaped = arg
    .replace(/[%]/g, '%%')
    .replace(/([&|<>()^"])/g, '^$1');
  if (WINDOWS_SAFE_ARG.test(arg)) return escaped;
  return `"${escaped}"`;
}
