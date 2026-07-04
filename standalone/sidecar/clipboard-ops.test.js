const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  readClipboardFilePaths,
  readClipboardImageAsFilePath,
  readClipboardText,
  writeClipboardText,
  parseUriList,
  splitNonEmptyLines,
} = require('./clipboard-ops');

// A fake child_process.spawn for writeClipboardText: records (cmd, args) and the
// text written to stdin, then fires `close`/`error` asynchronously like a real
// process. `behavior(cmd)` chooses the outcome per command ({ code } | { error }).
function fakeSpawn(behavior) {
  const calls = [];
  const writes = [];
  const spawn = (cmd, args, options) => {
    calls.push([cmd, args, options]);
    const handlers = {};
    return {
      on(event, cb) { handlers[event] = cb; return this; },
      stdin: {
        on() {},
        end(text) {
          writes.push([cmd, text]);
          const res = (behavior ? behavior(cmd) : null) || {};
          queueMicrotask(() => {
            if (res.error) handlers.error?.(res.error);
            else handlers.close?.(res.code ?? 0);
          });
        },
      },
    };
  };
  return { spawn, calls, writes };
}

function fakeOs(tmp = '/tmp/test') {
  return { tmpdir: () => tmp };
}

function fakeCrypto(uuid = 'uuid-0') {
  return { randomUUID: () => uuid };
}

function fakeFs() {
  const writes = [];
  const files = new Map();
  const unlinks = [];
  const chmods = [];
  const rmdirs = [];
  return {
    writes,
    files,
    unlinks,
    chmods,
    rmdirs,
    module: {
      promises: {
        async mkdtemp(prefix) { return `${prefix}dir-0`; },
        async chmod(p, mode) { chmods.push([p, mode]); },
        async writeFile(p, buf, opts) { writes.push([p, buf, opts]); files.set(p, buf); },
        async stat(p) {
          const b = files.get(p);
          if (!b) throw new Error('ENOENT');
          return { size: b.length };
        },
        async unlink(p) { unlinks.push(p); files.delete(p); },
        async rmdir(p) { rmdirs.push(p); },
      },
    },
  };
}

test('splitNonEmptyLines preserves leading and trailing path spaces', () => {
  assert.deepEqual(splitNonEmptyLines(' /tmp/leading.png\n/tmp/trailing.png \n'), [
    ' /tmp/leading.png',
    '/tmp/trailing.png ',
  ]);
});

test('parseUriList decodes file URIs and ignores comments/non-file', () => {
  const input = [
    '# comment',
    'file:///Users/me/a%20file.png',
    'file:///tmp/plain.txt',
    'https://example.com/nope',
    '',
  ].join('\n');
  assert.deepEqual(parseUriList(input), [
    '/Users/me/a file.png',
    '/tmp/plain.txt',
  ]);
});

test('readClipboardFilePaths on mac parses osascript linefeed-separated output', async () => {
  const paths = await readClipboardFilePaths({
    platform: 'darwin',
    exec: async (cmd, args) => {
      assert.equal(cmd, 'osascript');
      assert.equal(args[0], '-e');
      return { stdout: '/Users/me/a.png\n/Users/me/b.jpg\n' };
    },
  });
  assert.deepEqual(paths, ['/Users/me/a.png', '/Users/me/b.jpg']);
});

test('readClipboardFilePaths on mac returns [] when osascript fails', async () => {
  const paths = await readClipboardFilePaths({
    platform: 'darwin',
    exec: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(paths, []);
});

test('readClipboardFilePaths on windows parses FileDropList lines', async () => {
  const paths = await readClipboardFilePaths({
    platform: 'win32',
    exec: async (cmd) => {
      assert.equal(cmd, 'powershell');
      return { stdout: 'C:\\a.png\r\nC:\\b.jpg\r\n' };
    },
  });
  assert.deepEqual(paths, ['C:\\a.png', 'C:\\b.jpg']);
});

test('readClipboardFilePaths on linux prefers xclip in X11 and parses file URIs', async () => {
  const calls = [];
  const paths = await readClipboardFilePaths({
    platform: 'linux',
    env: {},
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'xclip') return { stdout: 'file:///tmp/one.png\nfile:///tmp/two.png\n' };
      throw new Error('should not reach');
    },
  });
  assert.deepEqual(paths, ['/tmp/one.png', '/tmp/two.png']);
  assert.equal(calls[0][0], 'xclip');
});

test('readClipboardFilePaths on linux prefers wl-paste under Wayland', async () => {
  const calls = [];
  const paths = await readClipboardFilePaths({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'wl-paste') return { stdout: 'file:///tmp/w.png\n' };
      throw new Error('should not reach');
    },
  });
  assert.deepEqual(paths, ['/tmp/w.png']);
  assert.equal(calls[0][0], 'wl-paste');
});

test('readClipboardFilePaths on linux falls back when first tool fails', async () => {
  const paths = await readClipboardFilePaths({
    platform: 'linux',
    env: {},
    exec: async (cmd) => {
      if (cmd === 'xclip') throw new Error('no xclip');
      return { stdout: 'file:///tmp/fb.png\n' };
    },
  });
  assert.deepEqual(paths, ['/tmp/fb.png']);
});

test('readClipboardImageAsFilePath on mac returns temp path on success', async () => {
  const fs = fakeFs();
  const timers = [];
  const result = await readClipboardImageAsFilePath({
    platform: 'darwin',
    osModule: fakeOs('/t'),
    cryptoModule: fakeCrypto('uuid-I'),
    fsModule: fs.module,
    setTimeoutFn: (cb, ms) => { timers.push({ cb, ms }); return { unref() {} }; },
    exec: async (cmd, args) => {
      assert.equal(cmd, 'osascript');
      const [, script] = args;
      const match = script.match(/POSIX file "([^"]+)"/);
      assert.ok(match, 'script should reference target path');
      fs.files.set(match[1], Buffer.from('fakepng'));
      return { stdout: 'ok\n' };
    },
  });
  const expected = path.join('/t', 'dormouse-drops-dir-0', 'uuid-I-clipboard.png');
  assert.equal(result, expected);
  assert.deepEqual(fs.chmods, [
    [path.join('/t', 'dormouse-drops-dir-0'), 0o700],
    [expected, 0o600],
  ]);
  // Cleanup was scheduled, but not yet run: the temp file still exists.
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5 * 60 * 1000);
  assert.equal(fs.unlinks.length, 0);

  // Firing the scheduled cleanup unlinks the file and its parent dir.
  timers[0].cb();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fs.unlinks, [expected]);
  assert.deepEqual(fs.rmdirs, [path.join('/t', 'dormouse-drops-dir-0')]);
});

test('readClipboardImageAsFilePath returns null when osascript returns empty', async () => {
  const fs = fakeFs();
  const result = await readClipboardImageAsFilePath({
    platform: 'darwin',
    osModule: fakeOs('/t'),
    cryptoModule: fakeCrypto('uuid-I'),
    fsModule: fs.module,
    exec: async () => ({ stdout: '' }),
  });
  assert.equal(result, null);
  assert.deepEqual(fs.rmdirs, [path.join('/t', 'dormouse-drops-dir-0')]);
});

test('readClipboardText on mac shells out to pbpaste', async () => {
  const calls = [];
  const text = await readClipboardText({
    platform: 'darwin',
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: 'hello clipboard' };
    },
  });
  assert.equal(text, 'hello clipboard');
  assert.deepEqual(calls, [['pbpaste', []]]);
});

test('readClipboardText on mac returns empty string when pbpaste fails', async () => {
  const text = await readClipboardText({
    platform: 'darwin',
    exec: async () => { throw new Error('no pbpaste'); },
  });
  assert.equal(text, '');
});

test('readClipboardText on windows strips Get-Clipboard trailing newline', async () => {
  const text = await readClipboardText({
    platform: 'win32',
    exec: async (cmd, args) => {
      assert.equal(cmd, 'powershell');
      assert.ok(args.includes('Get-Clipboard -Raw'));
      return { stdout: 'line1\r\nline2\r\n' };
    },
  });
  assert.equal(text, 'line1\r\nline2');
});

test('readClipboardText on linux prefers xclip in X11', async () => {
  const calls = [];
  const text = await readClipboardText({
    platform: 'linux',
    env: {},
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'xclip') return { stdout: 'x11 text' };
      throw new Error('should not reach');
    },
  });
  assert.equal(text, 'x11 text');
  assert.equal(calls[0][0], 'xclip');
});

test('readClipboardText on linux prefers wl-paste under Wayland', async () => {
  const calls = [];
  const text = await readClipboardText({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'wl-paste') return { stdout: 'wayland text' };
      throw new Error('should not reach');
    },
  });
  assert.equal(text, 'wayland text');
  assert.equal(calls[0][0], 'wl-paste');
});

test('readClipboardText on linux falls back when first tool fails', async () => {
  const text = await readClipboardText({
    platform: 'linux',
    env: {},
    exec: async (cmd) => {
      if (cmd === 'xclip') throw new Error('no xclip');
      return { stdout: 'fallback text' };
    },
  });
  assert.equal(text, 'fallback text');
});

test('readClipboardImageAsFilePath on linux writes buffer from exec stdout', async () => {
  const fs = fakeFs();
  const result = await readClipboardImageAsFilePath({
    platform: 'linux',
    env: {},
    osModule: fakeOs('/t'),
    cryptoModule: fakeCrypto('uuid-L'),
    fsModule: fs.module,
    exec: async (cmd) => {
      if (cmd === 'xclip') return { stdout: Buffer.from([0x89, 0x50, 0x4E, 0x47]) };
      throw new Error('no tool');
    },
  });
  assert.equal(result, path.join('/t', 'dormouse-drops-dir-0', 'uuid-L-clipboard.png'));
  assert.equal(fs.writes.length, 1);
  assert.deepEqual(fs.writes[0][2], { mode: 0o600 });
});

test('writeClipboardText on mac shells out to pbcopy via stdin', async () => {
  const f = fakeSpawn();
  await writeClipboardText('copied!', { platform: 'darwin', spawn: f.spawn });
  assert.deepEqual(f.calls.map((c) => [c[0], c[1]]), [['pbcopy', []]]);
  assert.deepEqual(f.writes, [['pbcopy', 'copied!']]);
});

test('writeClipboardText on windows shells out to clip', async () => {
  const f = fakeSpawn();
  await writeClipboardText('x', { platform: 'win32', spawn: f.spawn });
  assert.deepEqual(f.calls.map((c) => [c[0], c[1]]), [['clip', []]]);
});

test('writeClipboardText spawns with windowsHide so no console window flickers', async () => {
  const f = fakeSpawn();
  await writeClipboardText('x', { platform: 'win32', spawn: f.spawn });
  assert.equal(f.calls[0][2].windowsHide, true);
});

test('writeClipboardText on linux prefers xclip in X11', async () => {
  const f = fakeSpawn();
  await writeClipboardText('hi', { platform: 'linux', env: {}, spawn: f.spawn });
  assert.equal(f.calls[0][0], 'xclip');
  assert.deepEqual(f.calls[0][1], ['-selection', 'clipboard']);
});

test('writeClipboardText on linux prefers wl-copy under Wayland', async () => {
  const f = fakeSpawn();
  await writeClipboardText('hi', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, spawn: f.spawn });
  assert.equal(f.calls[0][0], 'wl-copy');
});

test('writeClipboardText on linux falls back when the first tool fails', async () => {
  const f = fakeSpawn((cmd) => (cmd === 'xclip' ? { code: 1 } : { code: 0 }));
  await writeClipboardText('hi', { platform: 'linux', env: {}, spawn: f.spawn });
  assert.deepEqual(f.calls.map((c) => c[0]), ['xclip', 'wl-copy']);
});

test('writeClipboardText rejects when the tool exits nonzero', async () => {
  const f = fakeSpawn(() => ({ code: 1 }));
  await assert.rejects(writeClipboardText('hi', { platform: 'darwin', spawn: f.spawn }));
});
