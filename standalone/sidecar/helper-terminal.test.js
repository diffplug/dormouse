const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { create, getOpenPortsForPids, openNativeDirectory, shellHasWork } = require('./pty-core');

test('Windows folder opening completes on launch and still reports spawn errors', () => {
  const child = new EventEmitter();
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  const results = [];
  openNativeDirectory('C:\\Users\\Me\\My Project', error => results.push(error), {
    platform: 'win32',
    env: { SystemRoot: 'D:\\Win' },
    spawn(exe, args, options) {
      // Absolute: Windows looks a bare name up in the working directory first.
      assert.equal(exe, 'D:\\Win\\explorer.exe');
      assert.deepEqual(args, ['C:\\Users\\Me\\My Project']);
      assert.equal(options.stdio, 'ignore');
      return child;
    },
  });
  assert.deepEqual(results, []);
  child.emit('spawn');
  child.emit('exit', 1);
  assert.deepEqual(results, [null]);
  assert.equal(unrefs, 1);

  const failed = new EventEmitter();
  const error = new Error('ENOENT');
  openNativeDirectory('C:\\repo', result => assert.equal(result, error), { platform: 'win32', spawn: () => failed });
  failed.emit('error', error);
});

test('POSIX folder opening retains exit-error reporting', () => {
  const error = new Error('xdg-open failed');
  openNativeDirectory('/tmp/a b', result => assert.equal(result, error), {
    platform: 'linux',
    execFile(exe, args, _options, done) {
      assert.equal(exe, 'xdg-open');
      assert.deepEqual(args, ['/tmp/a b']);
      done(error);
    },
  });
});

// The directory is terminal-reported (OSC 7), so its name is program-chosen.
test('macOS reveals the folder rather than opening it, so a bundle directory is never launched', () => {
  let called = 0;
  openNativeDirectory('/Users/me/clone/Evil.app', result => assert.equal(result, null), {
    platform: 'darwin',
    execFile(exe, args, _options, done) {
      called++;
      assert.equal(exe, 'open');
      assert.deepEqual(args, ['-R', '/Users/me/clone/Evil.app']);
      done(null);
    },
  });
  assert.equal(called, 1);
});

test('Windows refuses a folder whose path Explorer would split at a comma', () => {
  const results = [];
  openNativeDirectory('C:\\clone\\x,\\Users\\me\\evil.exe', error => results.push(error), {
    platform: 'win32',
    spawn() { throw new Error('Explorer must not be launched'); },
  });
  assert.equal(results.length, 1);
  assert.match(results[0].message, /comma/);
});

test('process inspection fails closed while ordinary port discovery remains fail-soft', async () => {
  const runtime = { platform: 'darwin', execFile() { throw new Error('ps failed'); } };
  assert.deepEqual(await getOpenPortsForPids([{ pid: 42 }], runtime), new Map([[42, []]]));
  await assert.rejects(shellHasWork(42, '/bin/zsh', runtime), /inspect/);
});

test('work inspection requires the terminal process to appear in the process table', async () => {
  for (const output of ['', 'invalid response', '1 0\n123 1']) {
    const runtime = { platform: 'darwin', execFile() { return output; } };
    await assert.rejects(shellHasWork(42, '/bin/zsh', runtime), /inspect/);
  }
  assert.equal(await shellHasWork(42, '/bin/zsh', { platform: 'darwin', execFile() { return '42 1'; } }), false);
  assert.equal(await shellHasWork(42, '/bin/zsh', { platform: 'darwin', execFile() { return '42 1\n43 42'; } }), true);
});

test('a Windows shell\'s own plumbing is no work, but what runs beneath it is', async () => {
  const table = (rows) => ({
    platform: 'win32',
    execFile: () => JSON.stringify(rows.map(([ProcessId, ParentProcessId, Name]) => ({ ProcessId, ParentProcessId, Name }))),
  });
  // Git Bash's launcher keeps MSYS bash beneath it; wsl.exe a relay and its host.
  const gitBash = [[42, 1, 'bash.exe'], [43, 42, 'bash.exe']];
  const wsl = [[42, 1, 'wsl.exe'], [43, 42, 'wsl.exe'], [44, 43, 'wslhost.exe'], [45, 44, 'conhost.exe']];
  const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const wslPath = 'C:\\Windows\\System32\\wsl.exe';
  assert.equal(await shellHasWork(42, gitBashPath, table(gitBash)), false);
  assert.equal(await shellHasWork(42, wslPath, table(wsl)), false);
  assert.equal(await shellHasWork(42, gitBashPath, table([...gitBash, [50, 43, 'node.exe']])), true);
  assert.equal(await shellHasWork(42, wslPath, table([...wsl, [50, 43, 'node.exe']])), true);
  // Under another shell, a process of that name is work.
  const cmdPath = 'C:\\Windows\\System32\\cmd.exe';
  assert.equal(await shellHasWork(42, cmdPath, table([[42, 1, 'cmd.exe'], [43, 42, 'bash.exe']])), true);
  assert.equal(await shellHasWork(42, cmdPath, table([[42, 1, 'cmd.exe']])), false);
});

test('helper ownership survives a live listing and promotion preserves the PTY and replay', () => {
  const events = [];
  const spawned = [];
  // Every helper decision, as the host's alerts hear it.
  const decisions = [];
  const manager = create((event, data) => events.push({ event, data }), {
    spawn() {
      const terminal = { pid: 42, write() {}, resize() {}, kill() {}, onData(callback) { this.output = callback; }, onExit() {} };
      spawned.push(terminal); return terminal;
    },
  }, { replay: true, onHelper: (id, helper) => decisions.push([id, helper]) });
  manager.spawn('parent');
  manager.spawn('helper', { helper: { parentId: 'parent', command: 'git status' } });
  assert.deepEqual(decisions, [['parent', false], ['helper', true]]);
  assert.equal(manager.getHelperParentId('helper'), 'parent');
  assert.equal(manager.getHelperParentId('parent'), undefined);
  spawned[1].output('unsaved editor text');
  manager.list();
  assert.deepEqual(events.findLast(e => e.event === 'list').data.ptys[1].helper, { parentId: 'parent', command: 'git status' });
  assert.equal(events.findLast(e => e.event === 'replay').data.data, 'unsaved editor text');
  manager.context({ op: 'promote', id: 'helper' }, 'promote-1');
  assert.deepEqual(decisions.at(-1), ['helper', false]);
  assert.equal(manager.getHelperParentId('helper'), undefined);
  manager.list();
  assert.equal(events.findLast(e => e.event === 'list').data.ptys[1].helper, undefined);
  assert.equal(spawned.length, 2);
  assert.equal(events.findLast(e => e.event === 'replay').data.data, 'unsaved editor text');
  manager.context({ op: 'promote', id: 'helper', restore: { parentId: 'parent', command: 'git status' } }, 'restore-1');
  manager.list();
  assert.equal(events.findLast(e => e.event === 'list').data.ptys[1].helper.parentId, 'parent');
  assert.deepEqual(decisions.at(-1), ['helper', true]);
  const decided = decisions.length;
  manager.context({ op: 'promote', id: 'parent', restore: { parentId: 'parent', command: '' } }, 'invalid-self');
  assert.match(events.at(-1).data.error, /Invalid helper owner/);
  // A refused promotion decides nothing.
  assert.equal(decisions.length, decided);
  manager.spawn('other');
  manager.context({ op: 'promote', id: 'other', restore: { parentId: 'parent', command: '' } }, 'invalid-duplicate');
  assert.match(events.at(-1).data.error, /Invalid helper owner/);
  manager.killAll();
});

test('replay retains the complete bounded tail across unequal output chunks', () => {
  const events = [];
  let output;
  const manager = create((event, data) => events.push({ event, data }), {
    spawn: () => ({ pid: 42, write() {}, resize() {}, kill() {}, onData(callback) { output = callback; }, onExit() {} }),
  }, { replay: true });
  manager.spawn('terminal');
  output('a'.repeat(199999));
  output('bc');
  manager.list();
  assert.equal(events.findLast(e => e.event === 'replay').data.data, 'a'.repeat(199998) + 'bc');
  manager.killAll();
});

test('a helper cannot own another helper or reference an absent owner', () => {
  const events = []; let spawns = 0;
  const manager = create((event, data) => events.push({ event, data }), {
    spawn() { spawns++; return { pid: 42, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }; },
  });
  manager.spawn('parent');
  manager.spawn('helper', { helper: { parentId: 'parent', command: '' } });
  manager.spawn('nested', { helper: { parentId: 'helper', command: '' } });
  manager.spawn('orphan', { helper: { parentId: 'missing', command: '' } });
  assert.equal(spawns, 2);
  assert.deepEqual(events.filter(e => e.event === 'exit').map(e => e.data.id), ['nested', 'orphan']);
  manager.killAll();
});

// The host's resolver (`canonicalLocalDirectory`) is the only thing that may
// touch the path: a `stat` or `realpath` follows a link to a share.
test('directory opening touches the path only through the host resolver', async (t) => {
  const refuse = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const stat = t.mock.method(fs, 'statSync', refuse);
  const realpath = t.mock.method(fs, 'realpathSync', refuse);
  const asked = [];
  const events = [];
  const manager = create((event, data) => events.push({ event, data }), { spawn() { throw new Error('unexpected spawn'); } }, {
    canonicalDirectory: async (path) => { asked.push(path); return null; },
  });
  const paths = [__dirname, '//host/share', '\\\\host\\share', '\\\\?\\C:\\repo', '../secret', '/tmp\0ignored', null];
  for (const path of paths) {
    await manager.context({ op: 'openDirectory', id: 'parent', path }, 'directory');
    assert.match(events.at(-1).data.error, /unavailable/, String(path));
  }
  assert.deepEqual(asked, paths);
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(realpath.mock.callCount(), 0);
});

// A WSL pane reports Linux directories and Git Bash MSYS ones; the Windows
// host's browsers and Explorer need the Windows path to the same directory.
test('a Windows pane\'s reported directory reaches the host as a Windows path', async () => {
  const asked = [];
  const events = [];
  const manager = create((event, data) => events.push({ event, data }), {
    spawn: () => ({ pid: 42, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }),
  }, { platform: 'win32', canonicalDirectory: async (path) => { asked.push(path); return null; } });
  manager.spawn('wsl', { shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] });
  manager.spawn('gitbash', { shell: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [] });
  manager.spawn('pwsh', { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [] });
  const hostDirectory = async (id, path) => {
    await manager.context({ op: 'hostDirectory', id, path }, 'host');
    return events.at(-1).data.path;
  };
  assert.equal(await hostDirectory('wsl', '/home/me/app'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
  assert.equal(await hostDirectory('wsl', '/mnt/c/Users/me'), 'C:\\Users\\me');
  assert.equal(await hostDirectory('wsl', '/mnt/d'), 'D:\\');
  assert.equal(await hostDirectory('gitbash', '/c/Users/me'), 'C:\\Users\\me');
  assert.equal(await hostDirectory('gitbash', 'C:\\Users\\me'), 'C:\\Users\\me');
  assert.equal(await hostDirectory('pwsh', '/home/me'), '/home/me');
  assert.equal(await hostDirectory('missing', '/home/me'), '/home/me');
  await manager.context({ op: 'openDirectory', id: 'wsl', path: '/mnt/c/Users/me' }, 'directory');
  assert.deepEqual(asked, ['C:\\Users\\me']);
  manager.killAll();
});
