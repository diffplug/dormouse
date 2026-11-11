import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';
import { validateToolArgs } from '../dist/commands/tool.js';
import { fakeTerminal, until } from './fake-terminal.mjs';

const ENV = { PWD: '/work/site', HOME: '/home/me' };

/** An approved project and a user file whose `storybook` the project hides;
 *  `--global` answers the user file alone, as the host does. */
function toolClient({ tools } = {}) {
  return {
    requests: [],
    async toolList(request) {
      this.requests.push({ method: 'toolList', request });
      const user = [
        { name: 'storybook', scope: 'user', run: 'npx storybook', render: 'iframe', port: 'auto', keyed: false, description: null, shadowed: !request.global },
        { name: 'md', scope: 'user', run: ['glow', '$TARGET'], render: 'iframe', port: 'announced', keyed: true, description: 'Render Markdown.', shadowed: false },
      ];
      return {
        project: request.global ? null : { path: '/work/site/dormouse.yml', approved: false },
        user: { path: '/home/me/.config/dormouse/dormouse.yml', found: true },
        tools: tools ?? [
          ...(request.global ? [] : [
            { name: 'storybook', scope: 'project', run: 'pnpm storybook', render: 'iframe', port: 'auto', keyed: true, description: 'The component catalog.\n\nView only.', shadowed: false },
            { name: 'harness', scope: 'project', run: 'pnpm harness', render: 'agent-browser-screencast', port: 'announced', keyed: true, description: null, shadowed: false },
          ]),
          ...user,
        ],
        warnings: ['/work/site/dormouse.yml: tools.harness: ignoring unknown field \'colour\''],
      };
    },
    async toolSurface(request) {
      this.requests.push({ method: 'toolSurface', request });
      return { status: 'created', surfaceId: 'surface:4', command: `run ${request.name}`, cwd: request.cwd, minimized: request.minimized, key: null };
    },
  };
}

/** Runs `dor tool <argv>` at a terminal and waits for the picker's list. */
async function startPicker(argv, { terminal = fakeTerminal(), client = toolClient() } = {}) {
  const result = runCli(['tool', ...argv], { client, terminal, env: ENV });
  await until(() => terminal.output.includes('md'), 'the Tool list');
  return { terminal, client, result };
}

/** Drawn text without its styling. */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const launch = (client) => client.requests.find(r => r.method === 'toolSurface')?.request;

test('a pick launches the Tool as dor tool <name> with the same flags would', async () => {
  const flags = ['--fresh', '--minimize', '--surface', 'surface:2', '--workspace', 'workspace:2', '--cwd', 'sub'];
  const { terminal, client, result } = await startPicker(flags);
  assert.deepEqual(client.requests[0], { method: 'toolList', request: { cwd: launch(await typed(flags, 'harness')).cwd, global: false } });
  terminal.send('harn');
  await until(() => terminal.output.includes('[agent-browser-screencast]'), 'the highlighted Tool');
  terminal.send('\r');
  const { exitCode, stdout, stderr } = await result;
  assert.equal(exitCode, 0);
  assert.equal(stdout, 'created surface:4  "run harness"\n');
  assert.equal(stderr, '', 'the listing warnings stay out; the launch prints its own');
  assert.deepEqual(launch(client), launch(await typed(flags, 'harness')));
  assert.equal(terminal.listening, false);
  assert.ok(terminal.output.endsWith('\x1b[?1049l'), 'leaves the alternate screen');
});

/** The client a typed `dor tool <flags> <name>` sent. */
async function typed(flags, name) {
  const client = toolClient();
  await runCli(['tool', ...flags, name], { client, env: ENV });
  return client;
}

test('the list is project Tools then user Tools in file order, a shadowed one marked', async () => {
  const { terminal, result } = await startPicker([]);
  const rows = terminal.output.split(/\x1b\[\d+;1H\x1b\[2K/).slice(2, 6).map(plain);
  assert.match(rows[0], /^› storybook {2}"pnpm storybook"/);
  assert.match(rows[1], /^ {2}harness {2}"pnpm harness"/);
  assert.match(rows[2], /^ {2}storybook {2}"npx storybook" {2}\[shadowed\]/);
  assert.match(rows[3], /^ {2}md {2}\["glow","\$TARGET"\]/);
  assert.match(terminal.output, /\[not approved\]/, 'the project Tool says its file is not approved');
  terminal.send('\x1b');
  await result;
});

test('a shadowed user Tool launches with --global', async () => {
  const { terminal, client, result } = await startPicker([]);
  terminal.send('\x1b[B\x1b[B\r');
  assert.equal((await result).exitCode, 0);
  assert.deepEqual(launch(client), launch(await typed(['--global'], 'storybook')));
  assert.equal(launch(client).global, true);
});

test('a project Tool launches without --global', async () => {
  const { terminal, client, result } = await startPicker([]);
  terminal.send('\r');
  await result;
  assert.deepEqual(launch(client), launch(await typed([], 'storybook')));
  assert.equal(launch(client).global, false);
});

test('--global offers only user Tools', async () => {
  const { terminal, client, result } = await startPicker(['--global']);
  assert.deepEqual(client.requests[0].request.global, true);
  assert.match(terminal.output, /2\/2/);
  assert.doesNotMatch(terminal.output, /pnpm storybook/);
  terminal.send('\r');
  await result;
  assert.deepEqual(launch(client), launch(await typed(['--global'], 'storybook')));
});

test('cancelling exits 1 silently and runs nothing', async () => {
  for (const key of ['\x1b', '\x03']) {
    const { terminal, client, result } = await startPicker([]);
    terminal.send(key);
    assert.deepEqual(await result, { exitCode: 1, stdout: '', stderr: '' });
    assert.equal(launch(client), undefined);
    assert.equal(terminal.listening, false);
  }
});

test('with no Tool declared, a terminal gets the listing and a pointer, not a picker', async () => {
  const terminal = fakeTerminal();
  const client = toolClient({ tools: [] });
  const result = await runCli(['tool'], { client, terminal, env: ENV });
  assert.equal(terminal.output, '', 'no picker drawn');
  const listed = await runCli(['tool', '--list'], { client: toolClient({ tools: [] }), env: ENV });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, listed.stderr);
  assert.equal(result.stdout, `${listed.stdout}Declare a Tool in either file; dor skill tools shows how.\n`);
});

test('--json at a terminal prints the JSON listing; a placement flag beside it fails', async () => {
  const terminal = fakeTerminal();
  const json = await runCli(['tool', '--json'], { client: toolClient(), terminal, env: ENV });
  assert.deepEqual(json, await runCli(['tool', '--list', '--json'], { client: toolClient(), env: ENV }));
  const placed = await runCli(['tool', '--json', '--minimize'], { client: toolClient(), terminal, env: ENV });
  assert.equal(placed.exitCode, 1);
  assert.match(placed.stderr, /dor tool requires a tool name or -- <command\.\.\.>/);
  assert.equal(terminal.output, '');
});

test('the query and highlighted Tool survive resizes', async () => {
  const { terminal, client, result } = await startPicker([], { terminal: fakeTerminal({ columns: 120, rows: 12 }) });
  terminal.send('ok');
  await until(() => /2\/4/.test(terminal.output), 'the narrowed list');
  terminal.send('\x1b[B');
  terminal.take();
  terminal.resize(60, 8);
  const narrow = terminal.take();
  assert.match(plain(narrow), /> ok/, 'the query is redrawn');
  assert.match(narrow, /1;5H/, 'the cursor stays after the query');
  assert.match(plain(narrow), /› storybook {2}"npx storybook"/, 'the highlight stays on its Tool');
  terminal.resize(140, 20);
  assert.match(plain(terminal.take()), /› storybook {2}"npx storybook"/);
  terminal.send('\r');
  await result;
  assert.equal(launch(client).global, true, 'Enter runs the Tool highlighted before the resizes');
});

test('a double-click runs the Tool clicked', async () => {
  const { terminal, client, result } = await startPicker([]);
  terminal.send('\x1b[<0;3;3M\x1b[<0;3;3M');
  await result;
  assert.equal(launch(client).name, 'harness');
});

// Spelled out so a narrower escape set reddens this: C0, C1, and the format
// characters that reorder or hide text.
const PLANTED = ['\x1b]52;c;x\x07', '\x9b31m', '\x1b[2J', '\u202e', '\u2067', '\u00ad'];

test('Tool names, commands, descriptions, and paths cannot write terminal controls', async () => {
  const evil = {
    name: 'evil\x1b]52;c;x\x07', scope: 'project', run: ['echo', '\x9b31m\u202e'], render: 'iframe', port: 'auto', keyed: false,
    description: 'fine\x1b[2Jtext \u202eexe.txt\nsoft\u00adhyphen', shadowed: false,
  };
  for (const columns of [120, 80]) {
    const client = toolClient({ tools: [evil, { ...evil, name: 'md', description: null }] });
    const listing = client.toolList.bind(client);
    client.toolList = async (request) => ({ ...(await listing(request)), project: { path: '/work/s\u2067ite/dormouse.yml', approved: true } });
    const { terminal, result } = await startPicker([], { client, terminal: fakeTerminal({ columns }) });
    await until(() => terminal.output.includes('evil\\u001b]52;c;x\\u0007'), 'the escaped name');
    assert.match(terminal.output, /\\u009b31m\\u202e/, `${columns}: the command is escaped`);
    assert.match(terminal.output, /fine\\u001b\[2Jtext \\u202eexe\.txt/, `${columns}: the description is escaped`);
    if (columns === 120) {
      assert.match(terminal.output, /soft\\u00adhyphen/);
      assert.match(terminal.output, /s\\u2067ite/, 'the file path is escaped');
    }
    for (const planted of PLANTED) assert.equal(terminal.output.includes(planted), false, `${columns}: ${JSON.stringify(planted)} drawn raw`);
    terminal.send('\x1b');
    await result;
  }
});

test('an imported Tool shows its file, and a broken import its reason, both escaped', async () => {
  const base = { scope: 'user', description: null, shadowed: false };
  const client = toolClient({ tools: [
    { ...base, name: 'md', run: ['glow', '$TARGET'], render: 'iframe', port: 'auto', keyed: false, from: '/home/me/cl\x1b[2Jone/dormouse.yml' },
    { ...base, name: 'gone', from: '/home/me/nodir/dormouse.yml', broken: '/home/me/nodir/dormouse.yml: not\x9b31m found' },
  ] });
  const { terminal, client: used, result } = await startPicker([], { client, terminal: fakeTerminal({ columns: 120 }) });
  // The highlighted import's panel names the file it came from.
  // The tag wraps in the panel, so match its two halves.
  await until(() => plain(terminal.output).includes('[from') && terminal.output.includes('/home/me/cl\\u001b[2Jone/dormouse.yml]'), 'the imported file');
  // A broken import's row says why in place of a command, before it is highlighted.
  assert.ok(plain(terminal.output).includes('gone  [broken: /home/me/nodir/dormouse.yml: not\\u009b31m found]'), 'the broken row');
  terminal.send('gone');
  await until(() => plain(terminal.output).includes('1/2'), 'the filtered list');
  for (const planted of ['\x1b[2J', '\x9b31m']) assert.equal(terminal.output.includes(planted), false, `${JSON.stringify(planted)} drawn raw`);
  // Picking it launches by name, so the host reports the reason.
  terminal.send('\r');
  await result;
  assert.equal(launch(used).name, 'gone');
});

test('validateToolArgs accepts the bare form with any flag; the -- form still needs its command', () => {
  for (const argv of [[], ['--global'], ['--minimize'], ['--json', '--cwd', 'x'], ['--surface', 'surface:2', '--fresh']]) {
    assert.deepEqual(validateToolArgs(argv), { ok: true, value: undefined }, argv.join(' '));
  }
  assert.equal(validateToolArgs(['--']).ok, false);
  assert.equal(validateToolArgs(['--global', '--', 'pnpm']).ok, false);
});
