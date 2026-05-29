export type ShellCommandKind = 'cmd' | 'posix' | 'powershell';

const POSIX_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WINDOWS_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;

export function shellCommandKind(shell: string | undefined, platformString: string): ShellCommandKind {
  const normalizedShell = (shell ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!normalizedShell && /win/i.test(platformString)) return 'cmd';
  if (normalizedShell === 'cmd.exe' || normalizedShell === 'cmd') return 'cmd';
  if (normalizedShell === 'powershell.exe' || normalizedShell === 'powershell' || normalizedShell === 'pwsh.exe' || normalizedShell === 'pwsh') {
    return 'powershell';
  }
  return 'posix';
}

export function commandShellArgs(shell: string | undefined, platformString: string, command: string): string[] {
  switch (shellCommandKind(shell, platformString)) {
    case 'cmd':
      return ['/d', '/s', '/c', command];
    case 'powershell':
      return ['-NoLogo', '-NoProfile', '-Command', command];
    case 'posix':
      return ['-lc', command];
  }
}

export function buildShellCommand(shell: string | undefined, platformString: string, argv: readonly string[]): string | undefined {
  if (argv.join('').trim() === '') return undefined;
  switch (shellCommandKind(shell, platformString)) {
    case 'cmd':
      return argv.map(quoteCmdArg).join(' ');
    case 'powershell':
      return quotePowerShellCommand(argv);
    case 'posix':
      return argv.map(quotePosixArg).join(' ');
  }
}

function quotePosixArg(arg: string): string {
  if (arg === '') return "''";
  if (POSIX_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellCommand(argv: readonly string[]): string {
  const [command, ...args] = argv;
  if (command === undefined) return '';
  const quotedCommand = quotePowerShellArg(command);
  const commandPrefix = quotedCommand.startsWith("'") ? '& ' : '';
  return `${commandPrefix}${[quotedCommand, ...args.map(quotePowerShellArg)].join(' ')}`;
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
