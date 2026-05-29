import { describe, expect, it } from 'vitest';
import { buildShellCommand, commandShellArgs, shellCommandKind } from './shell-command';

describe('shell command launch helpers', () => {
  it('detects the target shell from the selected shell and platform', () => {
    expect(shellCommandKind('/bin/zsh', 'darwin')).toBe('posix');
    expect(shellCommandKind('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellCommandKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell');
    expect(shellCommandKind(undefined, 'win32')).toBe('cmd');
  });

  it('quotes argv for POSIX shells', () => {
    expect(buildShellCommand('/bin/zsh', 'darwin', [
      'node',
      '-e',
      'console.log(process.argv[1])',
      'hello world',
      "it's",
      '',
    ])).toBe("node -e 'console.log(process.argv[1])' 'hello world' 'it'\\''s' ''");
  });

  it('quotes argv for PowerShell and invokes quoted command paths', () => {
    expect(buildShellCommand('pwsh.exe', 'win32', [
      'C:\\Program Files\\nodejs\\node.exe',
      '-e',
      'Write-Output $args[0]',
      'hello world',
      "it's",
    ])).toBe("& 'C:\\Program Files\\nodejs\\node.exe' -e 'Write-Output $args[0]' 'hello world' 'it''s'");
  });

  it('quotes argv for cmd.exe', () => {
    expect(buildShellCommand('cmd.exe', 'win32', [
      'C:\\Program Files\\nodejs\\node.exe',
      '-e',
      'console.log(process.argv[1])',
      'hello world',
      'a&b',
    ])).toBe('"C:\\Program Files\\nodejs\\node.exe" -e "console.log^(process.argv[1]^)" "hello world" "a^&b"');
  });

  it('returns shell launch args for the detected shell', () => {
    expect(commandShellArgs('/bin/zsh', 'darwin', 'pnpm test')).toEqual(['-lc', 'pnpm test']);
    expect(commandShellArgs('cmd.exe', 'win32', 'pnpm test')).toEqual(['/d', '/s', '/c', 'pnpm test']);
    expect(commandShellArgs('pwsh.exe', 'win32', 'pnpm test')).toEqual(['-NoLogo', '-NoProfile', '-Command', 'pnpm test']);
  });
});
