import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { fuzzyMatch, rankMatches } from '../dist/commands/fuzzy.js';
import { parseKeys } from '../dist/commands/open-picker.js';

test('ranking prefers basename and boundary matches, then shorter paths', () => {
  const files = ['lib/src/host/tool-open.test.ts', 'docs/topen.md', 'lib/src/host/tool-open.ts', 'tools/open/x.ts'];
  assert.deepEqual(rankMatches('toolopen', files).results.map(r => r.item).slice(0, 2), ['lib/src/host/tool-open.ts', 'lib/src/host/tool-open.test.ts']);
  assert.deepEqual(rankMatches('readme', ['docs/README.md', 'README.md', 'src/read/me.ts']).results[0].item, 'README.md');
  // Every term must match; matched keeps input order for narrowing.
  assert.deepEqual(rankMatches('host test', files).matched, ['lib/src/host/tool-open.test.ts']);
  assert.deepEqual(rankMatches('', files).results.map(r => r.item), files);
});

test('matching is smart-case and reports matched indices', () => {
  assert.ok(fuzzyMatch('wall', 'src/Wall.tsx'));
  assert.equal(fuzzyMatch('Wall', 'src/wall.tsx'), null);
  assert.deepEqual(fuzzyMatch('wt', 'src/Wall.tsx').positions, [4, 9]);
  // A character whose lowercase is longer keeps indices aligned.
  assert.deepEqual(fuzzyMatch('x', 'İx').positions, [1]);
});

test('parseKeys decodes keys, mouse, paste, and a lone escape', () => {
  assert.deepEqual(parseKeys('ab\x1b[A\x1b[B\t\x1b[Z\r'), [
    { kind: 'text', text: 'ab' }, { kind: 'up' }, { kind: 'down' }, { kind: 'nextHandler' }, { kind: 'previousHandler' }, { kind: 'enter' },
  ]);
  assert.deepEqual(parseKeys('\x1b[<0;5;3M\x1b[<0;5;3m\x1b[<64;1;1M\x1b[<65;1;1M'), [
    { kind: 'click', row: 2, column: 4 }, { kind: 'wheelUp' }, { kind: 'wheelDown' },
  ]);
  assert.deepEqual(parseKeys('\x1b[200~a\nb\x1b\x1b[201~'), [{ kind: 'paste', text: 'a b' }]);
  assert.deepEqual(parseKeys('\x1b'), [{ kind: 'cancel' }]);
  assert.deepEqual(parseKeys('\x1b[5~\x1b[6~\x7f\x15\x17'), [
    { kind: 'pageUp' }, { kind: 'pageDown' }, { kind: 'backspace' }, { kind: 'clear' }, { kind: 'word' },
  ]);
});

function fakeTerminal({ columns = 120, rows = 20 } = {}) {
  let onInput;
  let output = '';
  return {
    columns: () => columns,
    rows: () => rows,
    write: (text) => { output += text; },
    listen(input) { onInput = input; return () => { onInput = undefined; }; },
    send(chunk) { onInput(chunk); },
    get output() { return output; },
    get listening() { return onInput !== undefined; },
  };
}

const HANDLERS = [
  { tool: 'builtin:file', description: 'Markdown editor', reason: 'built-in; no open rule matches' },
  { tool: 'builtin:code', description: 'code editor (source)', reason: 'built-in' },
];

function pickerClient({ handlers = async () => ({ target: '/x', directory: false, handlers: HANDLERS, config: '/home/me/.config/dormouse/dormouse.yml', warnings: [] }) } = {}) {
  return {
    requests: [],
    async openHandlers(request) {
      this.requests.push({ method: 'openHandlers', request });
      return handlers(request);
    },
    async toolSurface(request) {
      this.requests.push({ method: 'toolSurface', request });
      return { status: 'created', surfaceId: 'pane-x', surfaceRef: 'surface:9', command: `viewer ${request.file}`, cwd: request.cwd, minimized: false, key: null };
    },
  };
}

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function withTree(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dor-picker-'));
  try {
    await mkdir(join(dir, 'docs'));
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'docs', 'README.md'), '# hi');
    await writeFile(join(dir, 'main.ts'), '');
    await writeFile(join(dir, 'node_modules', 'skipped.md'), '');
    await writeFile(join(dir, '.hidden.md'), '');
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `dor <argv>` with the picker, waits for its list, then hands over. */
async function startPicker(dir, argv, options = {}) {
  const terminal = options.terminal ?? fakeTerminal();
  const client = options.client ?? pickerClient();
  const result = runCli(argv, { client, terminal, env: { PWD: dir, HOME: '/home/me' } });
  await until(() => terminal.output.includes('main.ts'), 'the file list');
  return { terminal, client, result };
}

test('dor o picks a file, shows why its handler opens it, and opens another handler', async () => {
  await withTree(async (dir) => {
    const { terminal, client, result } = await startPicker(dir, ['o']);
    // Outside a work tree: hidden files and node_modules stay out.
    assert.doesNotMatch(terminal.output, /skipped|hidden/);
    terminal.send('rdm');
    await until(() => terminal.output.includes('no open rule matches'), 'the handler panel');
    assert.match(terminal.output, /Opens with/);
    assert.match(terminal.output, /Markdown editor/);
    terminal.send('\t\r');
    const { exitCode, stdout } = await result;
    assert.equal(exitCode, 0);
    assert.equal(stdout, 'created surface:9  "viewer docs/README.md"\n');
    assert.deepEqual(client.requests.find(r => r.method === 'openHandlers').request, { target: 'docs/README.md', cwd: dir });
    assert.deepEqual(client.requests.find(r => r.method === 'toolSurface').request, {
      file: 'docs/README.md', tool: 'builtin:code', fresh: false, minimized: false, surface: undefined, cwd: dir,
    });
    assert.equal(terminal.listening, false);
    assert.ok(terminal.output.endsWith('\x1b[?1049l'), 'leaves the alternate screen');
  });
});

test('the default handler opens without --tool, and a narrow terminal shows it on one line', async () => {
  await withTree(async (dir) => {
    const { terminal, client, result } = await startPicker(dir, ['open', '--preview'], { terminal: fakeTerminal({ columns: 60 }) });
    terminal.send('readme');
    await until(() => terminal.output.includes('→ builtin:file (1/2)'), 'the status line');
    assert.doesNotMatch(terminal.output, /Opens with/);
    terminal.send('\r');
    await result;
    assert.equal(client.requests.find(r => r.method === 'openHandlers').request.preview, true);
    const open = client.requests.find(r => r.method === 'toolSurface').request;
    assert.equal(open.tool, undefined);
    assert.equal(open.preview, true);
  });
});

test('cancelling exits 1 silently and opens nothing', async () => {
  await withTree(async (dir) => {
    const { terminal, client, result } = await startPicker(dir, ['o']);
    terminal.send('\x03');
    assert.deepEqual(await result, { exitCode: 1, stdout: '', stderr: '' });
    assert.equal(client.requests.some(r => r.method === 'toolSurface'), false);
  });
});

test('--tool fixes the handler without asking the host', async () => {
  await withTree(async (dir) => {
    const { terminal, client, result } = await startPicker(dir, ['o', '--tool', 'glow']);
    terminal.send('readme');
    await until(() => terminal.output.includes('chosen by --tool'), 'the fixed handler');
    terminal.send('\t\r');
    await result;
    assert.equal(client.requests.some(r => r.method === 'openHandlers'), false);
    assert.equal(client.requests.find(r => r.method === 'toolSurface').request.tool, 'glow');
  });
});

test('a host without the handler read still opens the default', async () => {
  await withTree(async (dir) => {
    const client = pickerClient({ handlers: async () => { throw new Error("unsupported Dormouse control method 'tool.openHandlers'"); } });
    const { terminal, result } = await startPicker(dir, ['o'], { client });
    terminal.send('main');
    await until(() => terminal.output.includes('Unknown: unsupported'), 'the error');
    terminal.send('\t\r');
    await result;
    assert.equal(client.requests.find(r => r.method === 'toolSurface').request.tool, undefined);
  });
});

test('file names cannot write terminal controls', async () => {
  await withTree(async (dir) => {
    await writeFile(join(dir, 'evil\x1b]0;pwned\x07.md'), '');
    const { terminal, result } = await startPicker(dir, ['o']);
    terminal.send('evil');
    await until(() => terminal.output.includes('evil\\u001b]0;pwned\\u0007.md'), 'the sanitized name');
    assert.equal(terminal.output.includes('\x1b]0;pwned'), false);
    terminal.send('\x1b');
    await result;
  });
});

test('without a terminal, dor open needs a path; dor o FILE is dor open FILE', async () => {
  await withTree(async (dir) => {
    const client = pickerClient();
    assert.deepEqual(await runCli(['o'], { client, env: { PWD: dir } }), {
      exitCode: 1, stdout: '', stderr: 'Error: dor open needs a path when it is not run in an interactive terminal\n',
    });
    await runCli(['o', 'main.ts'], { client, env: { PWD: dir } });
    assert.equal(client.requests.find(r => r.method === 'toolSurface').request.file, 'main.ts');
  });
});
