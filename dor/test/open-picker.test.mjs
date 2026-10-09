import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { fuzzyMatch, Ranker } from '../dist/commands/fuzzy.js';
import { parseKeys, runFilePicker } from '../dist/commands/open-picker.js';
import { listFiles } from '../dist/commands/file-list.js';
import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';

const settle = async (ranker) => { while (ranker.scanning) await setImmediate(); };

/** Ranks the batches against `query` to completion, best first. */
async function rank(query, ...batches) {
  const ranker = new Ranker(() => {});
  for (const batch of batches) ranker.add(batch);
  ranker.setQuery(query);
  await settle(ranker);
  return Array.from({ length: ranker.count }, (_, i) => ranker.at(i));
}

test('ranking prefers basename and boundary matches, then shorter paths', async () => {
  const files = ['lib/src/host/tool-open.test.ts', 'docs/topen.md', 'lib/src/host/tool-open.ts', 'tools/open/x.ts'];
  assert.deepEqual((await rank('toolopen', files)).slice(0, 2), ['lib/src/host/tool-open.ts', 'lib/src/host/tool-open.test.ts']);
  assert.equal((await rank('readme', ['docs/README.md', 'README.md', 'src/read/me.ts']))[0], 'README.md');
  assert.deepEqual(await rank('host test', files), ['lib/src/host/tool-open.test.ts']);
  assert.deepEqual(await rank('', files), files);
});

test('the ranker merges streamed batches, narrows mid-scan, and keeps the selection in place', async () => {
  const many = Array.from({ length: 50_000 }, (_, i) => `src/module${i}/index.ts`);
  const ranker = new Ranker(() => {});
  ranker.add(many);
  ranker.setQuery('module4');
  assert.equal(ranker.scanning, true, 'ranking runs after setQuery returns');
  ranker.setQuery('module49');
  await settle(ranker);
  assert.deepEqual(await rank('module49', many), Array.from({ length: ranker.count }, (_, i) => ranker.at(i)), 'narrowing mid-scan loses nothing');
  ranker.select(3);
  const chosen = ranker.at(3);
  ranker.add(['zz/module49.ts']);
  await settle(ranker);
  assert.equal(ranker.at(0), 'zz/module49.ts', 'a later batch ranks into place');
  assert.equal(ranker.at(ranker.cursor), chosen, 'the selection follows its file');
  ranker.setQuery('module');
  ranker.flush();
  assert.equal(ranker.scanning, false, 'flush ranks everything listed now');
  assert.equal(ranker.cursor, 0, 'a new query drops the selection');
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
    { kind: 'click', row: 2, column: 4 }, { kind: 'up' }, { kind: 'down' },
  ]);
  assert.deepEqual(parseKeys('\x1b[200~a\nb\x1b\x1b[201~'), [{ kind: 'text', text: 'a b' }]);
  assert.deepEqual(parseKeys('\x1b'), [{ kind: 'cancel' }]);
  assert.deepEqual(parseKeys('\x1b[5~\x1b[6~\x7f\x15\x17'), [
    { kind: 'pageUp' }, { kind: 'pageDown' }, { kind: 'backspace' }, { kind: 'clear' }, { kind: 'word' },
  ]);
});

function fakeTerminal({ columns = 120, rows = 20 } = {}) {
  let onInput;
  let onResize;
  let output = '';
  return {
    columns: () => columns,
    rows: () => rows,
    write: (text) => { output += text; },
    listen(input, resize) { onInput = input; onResize = resize; return () => { onInput = undefined; onResize = undefined; }; },
    send(chunk) { onInput(chunk); },
    resize(width, height) { columns = width; rows = height; onResize(); },
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

test('picker redraws only changed rows, skips identical frames, and repaints after resize', async () => {
  const terminal = fakeTerminal({ columns: 60, rows: 8 });
  const result = runFilePicker({
    terminal,
    fixedTool: 'builtin:file',
    async listFiles(onFiles) { onFiles(['a'.repeat(58), 'b.ts']); return { truncated: false }; },
    async handlers() { assert.fail('fixed handler needs no lookup'); },
  });
  try {
    await until(() => terminal.output.includes('2/2'), 'completed listing');
    // Both the query/count row and the first file fill the terminal width.
    assert.doesNotMatch(terminal.output, /2\/2\x1b\[0m\x1b\[0m\x1b\[K/);
    assert.doesNotMatch(terminal.output, /a{58}\x1b\[0m\x1b\[0m\x1b\[K/);
    const before = terminal.output;
    terminal.send('\x1b[A'); // Already at the top.
    terminal.resize(60, 8);
    assert.equal(terminal.output, before, 'unchanged frames emit no bytes or cursor toggles');

    terminal.send('\x1b[B');
    const update = terminal.output.slice(before.length);
    assert.deepEqual([...update.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [2, 3]);
    assert.ok(update.endsWith('\x1b[1;3H\x1b[?25h\x1b[?2026l'), 'returns the cursor to the query');

    const unfiltered = terminal.output.length;
    terminal.send('b');
    const filtered = terminal.output.slice(unfiltered);
    assert.match(filtered, /b\x1b\[0m\x1b\[1m\.ts\x1b\[0m\x1b\[0m\x1b\[K/, 'shorter replacement clears the old row tail');
    assert.doesNotMatch(filtered, /0…\/2/, 'typing does not paint an empty list before ranking');
    const narrow = terminal.output.length;
    terminal.resize(120, 10);
    assert.deepEqual([...terminal.output.slice(narrow).matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.match(terminal.output.slice(narrow), /Opens with/);
    const wide = terminal.output.length;
    terminal.resize(60, 6);
    assert.deepEqual([...terminal.output.slice(wide).matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
    assert.match(terminal.output.slice(wide), /1;4H/, 'query cursor survives resize');
    terminal.send('\r');
    assert.deepEqual(await result, { file: 'b.ts' });
  } finally {
    if (terminal.listening) terminal.send('\x03');
    await result;
  }
});

test('handler replies leave unchanged file rows alone', async () => {
  const terminal = fakeTerminal({ columns: 60 });
  let reply;
  const result = runFilePicker({
    terminal,
    async listFiles(onFiles) { onFiles(['a.ts', 'b.ts']); return { truncated: false }; },
    handlers: () => new Promise(resolve => { reply = resolve; }),
  });
  try {
    await until(() => reply !== undefined, 'handler request');
    const before = terminal.output.length;
    reply({ handlers: HANDLERS, config: '/config', warnings: [], target: '/a.ts', directory: false });
    await until(() => terminal.output.includes('builtin:file'), 'handler reply');
    const update = terminal.output.slice(before);
    assert.doesNotMatch(update, /a\.ts|b\.ts/);
    assert.deepEqual([...update.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [19, 20]);
  } finally {
    terminal.send('\x03');
    await result;
  }
});

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

test('a handler chosen for one file never opens another that Enter lands on', async () => {
  await withTree(async (dir) => {
    const { terminal, client, result } = await startPicker(dir, ['o']);
    terminal.send('main');
    await until(() => client.requests.some(r => r.request.target === 'main.ts'), 'main.ts handlers');
    terminal.send('\x15readme');
    await until(() => client.requests.some(r => r.request.target === 'docs/README.md'), 'README handlers');
    await until(() => terminal.output.includes('no open rule matches'), 'the README panel');
    terminal.send('\t');
    // One chunk: a new query and Enter, with no render between them.
    terminal.send('\x15main\r');
    await result;
    assert.deepEqual(client.requests.find(r => r.method === 'toolSurface').request.file, 'main.ts');
    assert.equal(client.requests.find(r => r.method === 'toolSurface').request.tool, undefined);
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

// Windows file names cannot hold a colon.
test('a listed file whose name looks like a URL scheme opens as a path', { skip: process.platform === 'win32' }, async () => {
  await withTree(async (dir) => {
    await writeFile(join(dir, 'notes:draft.md'), '');
    const { terminal, client, result } = await startPicker(dir, ['o']);
    terminal.send('draft');
    await until(() => client.requests.some(r => r.method === 'openHandlers'), 'the handler read');
    terminal.send('\r');
    await result;
    assert.equal(client.requests.find(r => r.method === 'openHandlers').request.target, './notes:draft.md');
    assert.equal(client.requests.find(r => r.method === 'toolSurface').request.file, './notes:draft.md');
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

test('outside git, the walk hands each repo it reaches to git and skips macOS Library', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dor-walk-'));
  try {
    const repo = join(dir, 'projects', 'app');
    for (const sub of ['.github', 'build', 'src']) await mkdir(join(repo, sub), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'gone.ts'), '');
    execFileSync('git', ['add', 'gone.ts'], { cwd: repo });
    await rm(join(repo, 'gone.ts'));
    await writeFile(join(repo, '.gitignore'), 'build/\n');
    await writeFile(join(repo, '.github', 'ci.yml'), '');
    await writeFile(join(repo, 'build', 'out.js'), '');
    await writeFile(join(repo, 'src', 'a.ts'), '');
    await mkdir(join(dir, 'Library', 'Caches'), { recursive: true });
    await writeFile(join(dir, 'Library', 'Caches', 'junk'), '');
    await mkdir(join(dir, '.hidden'));
    await writeFile(join(dir, '.hidden', 'x'), '');
    await writeFile(join(dir, 'notes.txt'), '');
    const batches = [];
    const { truncated } = await listFiles(dir, { onFiles: paths => batches.push(paths), home: dir });
    const files = batches.flat().sort();
    assert.equal(truncated, false);
    assert.deepEqual(files, [
      ...(process.platform === 'darwin' ? [] : ['Library/Caches/junk']),
      'notes.txt', 'projects/app/.github/ci.yml', 'projects/app/.gitignore', 'projects/app/src/a.ts',
    ]);
    const aborted = new AbortController();
    aborted.abort();
    const none = [];
    await listFiles(dir, { onFiles: paths => none.push(...paths), signal: aborted.signal });
    assert.deepEqual(none, [], 'an aborted walk lists nothing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listing a repository never runs the fsmonitor its own config names', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dor-fsmonitor-'));
  try {
    const repo = join(dir, 'repo');
    const marker = join(dir, 'fsmonitor-ran');
    const hook = join(dir, 'fsmonitor.sh');
    await writeFile(hook, `#!/bin/sh\necho > '${marker}'\n`);
    await chmod(hook, 0o755);
    await mkdir(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'a.ts'), '');
    execFileSync('git', ['add', 'a.ts'], { cwd: repo });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repo });
    const files = [];
    await listFiles(repo, { onFiles: paths => files.push(...paths) });
    assert.deepEqual(files, ['a.ts']);
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
