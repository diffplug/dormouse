const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { create, getDescendantPids, openNativeDirectory } = require('./pty-core');

test('Windows folder opening completes on launch and still reports spawn errors', () => {
  const child = new EventEmitter();
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  const results = [];
  openNativeDirectory('C:\\Users\\Me\\My Project', error => results.push(error), {
    platform: 'win32',
    spawn(exe, args, options) {
      assert.equal(exe, 'explorer.exe');
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

test('process inspection fails closed while ordinary port discovery remains fail-soft', () => {
  const runtime = { platform: 'darwin', execFileSync() { throw new Error('ps failed'); } };
  assert.deepEqual(getDescendantPids(42, runtime), [42]);
  assert.throws(() => getDescendantPids(42, { ...runtime, strict: true }), /inspect/);
});

test('strict inspection requires the terminal process to appear in the process table', () => {
  for (const output of ['', 'invalid response', '1 0\n123 1']) {
    const runtime = { platform: 'darwin', execFileSync() { return output; } };
    assert.deepEqual(getDescendantPids(42, runtime), [42]);
    assert.throws(() => getDescendantPids(42, { ...runtime, strict: true }), /inspect/);
  }
  assert.deepEqual(getDescendantPids(42, { platform: 'darwin', strict: true, execFileSync() { return '42 1\n43 42'; } }), [42, 43]);
});

test('helper ownership survives a live listing and promotion preserves the PTY and replay', () => {
  const events = [];
  const spawned = [];
  const manager = create((event, data) => events.push({ event, data }), {
    spawn() {
      const terminal = { pid: 42, write() {}, resize() {}, kill() {}, onData(callback) { this.output = callback; }, onExit() {} };
      spawned.push(terminal); return terminal;
    },
  }, { replay: true });
  manager.spawn('parent');
  manager.spawn('helper', { helper: { parentId: 'parent', command: 'git status' } });
  // What the host's alerts mirror after each spawn and promotion.
  assert.equal(manager.isHelper('parent'), false);
  assert.equal(manager.isHelper('helper'), true);
  spawned[1].output('unsaved editor text');
  manager.list();
  assert.deepEqual(events.findLast(e => e.event === 'list').data.ptys[1].helper, { parentId: 'parent', command: 'git status' });
  assert.equal(events.findLast(e => e.event === 'replay').data.data, 'unsaved editor text');
  manager.context({ op: 'promote', id: 'helper' }, 'promote-1');
  assert.equal(manager.isHelper('helper'), false);
  manager.list();
  assert.equal(events.findLast(e => e.event === 'list').data.ptys[1].helper, undefined);
  assert.equal(spawned.length, 2);
  assert.equal(events.findLast(e => e.event === 'replay').data.data, 'unsaved editor text');
  manager.context({ op: 'promote', id: 'helper', restore: { parentId: 'parent', command: 'git status' } }, 'restore-1');
  manager.list();
  assert.equal(events.findLast(e => e.event === 'list').data.ptys[1].helper.parentId, 'parent');
  manager.context({ op: 'promote', id: 'parent', restore: { parentId: 'parent', command: '' } }, 'invalid-self');
  assert.match(events.at(-1).data.error, /Invalid helper owner/);
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

test('directory opening rejects relative paths and malformed input', () => {
  const events = [];
  const manager = create((event, data) => events.push({ event, data }), { spawn() { throw new Error('unexpected spawn'); } });
  for (const path of ['../secret', '$(echo unsafe)', '/tmp\0ignored', null]) {
    manager.context({ op: 'openDirectory', id: 'parent', path }, 'directory');
    assert.match(events.at(-1).data.error, /unavailable/);
  }
});
