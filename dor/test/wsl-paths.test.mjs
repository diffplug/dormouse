import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';
import { callerWslDistro, linuxPathText, windowsPathOf } from '../dist/commands/wsl-paths.js';

test('Linux paths map to the drive mount or the distro share', () => {
  assert.equal(windowsPathOf('/mnt/c/Users/me/shot.png', 'Ubuntu'), 'C:\\Users\\me\\shot.png');
  assert.equal(windowsPathOf('/mnt/d', 'Ubuntu'), 'D:\\');
  assert.equal(windowsPathOf('/home/me/app/shot.png', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\shot.png');
});

test('Windows paths the CLI reports come back as Linux paths, in text and JSON', () => {
  assert.equal(linuxPathText('✓ Screenshot saved to C:\\Users\\ME~1\\AppData\\Local\\Temp\\s.png\n', 'Ubuntu'),
    '✓ Screenshot saved to /mnt/c/Users/ME~1/AppData/Local/Temp/s.png\n');
  assert.equal(linuxPathText('{"path":"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\me\\\\s.png"}', 'Ubuntu'), '{"path":"/home/me/s.png"}');
  assert.equal(linuxPathText('{"path":"C:\\\\tmp\\\\s.png"}', 'Ubuntu'), '{"path":"/mnt/c/tmp/s.png"}');
  // Another distro's share is not this caller's filesystem.
  assert.equal(linuxPathText('\\\\wsl$\\Debian\\home\\x', 'Ubuntu'), '\\\\wsl$\\Debian\\home\\x');
  assert.equal(linuxPathText('no paths: 10:30, http://localhost:5173/', 'Ubuntu'), 'no paths: 10:30, http://localhost:5173/');
  // A directory may hold a space; a filename still ends at one.
  assert.equal(linuxPathText('saved to C:\\Users\\John Doe\\Pictures\\s.png now', 'Ubuntu'), 'saved to /mnt/c/Users/John Doe/Pictures/s.png now');
  assert.equal(linuxPathText('{"path":"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\me\\\\my shots\\\\s.png"}', 'Ubuntu'), '{"path":"/home/me/my shots/s.png"}');
});

test('only a Windows dor with a plain distro name has a WSL caller', () => {
  assert.equal(callerWslDistro({ WSL_DISTRO_NAME: 'Ubuntu-24.04' }, 'win32'), 'Ubuntu-24.04');
  assert.equal(callerWslDistro({ WSL_DISTRO_NAME: '..\\x' }, 'win32'), undefined);
  assert.equal(callerWslDistro({}, 'win32'), undefined);
  // A Linux dor inside the distro sees the same variable.
  assert.equal(callerWslDistro({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), undefined);
});

function wslCall(stdout = '') {
  const argsSeen = [];
  return {
    argsSeen,
    options: {
      env: { PWD: process.cwd(), WSL_DISTRO_NAME: 'Ubuntu' },
      client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' } }), browserSurface: async () => ({}) },
      execAgentBrowser: async (_binary, args) => { if (!args.includes('stream')) argsSeen.push(args); return { exitCode: 0, stdout, stderr: '' }; },
      execPlaywright: async (_binary, args) => { if (!args.includes('stream')) argsSeen.push(args); return { exitCode: 0, stdout, stderr: '' }; },
    },
  };
}

test('a WSL caller\'s path arguments reach the Windows CLI as Windows paths', { skip: process.platform !== 'win32' && 'needs C:\\Windows' }, async () => {
  const { argsSeen, options } = wslCall('✓ Screenshot saved to C:\\Windows\\Temp\\s.png\n');
  const result = await runCli(['agent-browser', 'screenshot', '/mnt/c/Windows/Temp/s.png'], options);
  assert.deepEqual(argsSeen[0].slice(2), ['screenshot', 'C:\\Windows\\Temp\\s.png']);
  assert.equal(result.stdout, '✓ Screenshot saved to /mnt/c/Windows/Temp/s.png\n');

  // An XPath in a path verb names no directory, and a non-path verb is untouched.
  await runCli(['agent-browser', 'upload', '/html/body/input', '/mnt/c/Windows/win.ini'], options);
  assert.deepEqual(argsSeen[1].slice(2), ['upload', '/html/body/input', 'C:\\Windows\\win.ini']);
  await runCli(['agent-browser', 'fill', '@e1', '/mnt/c/Windows'], options);
  assert.deepEqual(argsSeen[2].slice(2), ['fill', '@e1', '/mnt/c/Windows']);

  await runCli(['playwright', 'screenshot', '--filename=/mnt/c/Windows/Temp/p.png'], options);
  assert.deepEqual(argsSeen[3].slice(-2), ['screenshot', '--filename=C:\\Windows\\Temp\\p.png']);
});

test('a WSL caller without a Windows install is told where to install it', { skip: process.platform !== 'win32' && 'a Windows dor only' }, async () => {
  const result = await runCli(['agent-browser', 'open', 'https://example.com'], {
    env: { PWD: process.cwd(), WSL_DISTRO_NAME: 'Ubuntu', DORMOUSE_AGENT_BROWSER_BIN: '/nowhere/agent-browser', PATH: '' },
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /From WSL, dor runs agent-browser on Windows: install it there, in PowerShell, not inside Ubuntu\./);
});
